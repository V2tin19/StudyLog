/**
 * /api/admin/agent/schedule —— 排期入口（AI 自动排布时间块）
 *
 *   GET  /api/admin/agent/schedule?date=YYYY-MM-DD   看某天的时段 + 空闲窗
 *   POST /api/admin/agent/schedule                   排期（直接应用，快照可撤销）
 *        body: { date: 'today'|'YYYY-MM-DD'|'tomorrow',
 *                allocations: [{ subject, minutes, taskId?, topic? }] }
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 *
 * 排期纪律：
 * - 引擎是确定性的（_scheduler.js），LLM 只负责聊天入口的意图解析和内容细化；
 * - 已有时段原样保留，新块只往空闲窗里填；
 * - 每次应用前快照 days[date] 进 agent_undo，说「撤销」或调 undo 接口可回滚。
 */

import { json, dbMissing, requireAdmin } from '../../_shared.js';
import { applySchedule } from '../../agent/_agent.js';
import { readDoc } from '../../agent/_store.js';
import { day_plan, render_day, countdown_text } from '../../agent/_stats.js';
import { shanghaiToday, shanghaiNowHHMM } from '../../agent/_nlu.js';
import { resolve_plan_day, toMin } from '../../agent/_scheduler.js';

const NO_STORE = { 'cache-control': 'no-store' };

/* ---------------- GET：某天的时段 + 空闲窗 ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const url = new URL(request.url);
  const dateParam = url.searchParams.get('date') || 'today';
  const today = shanghaiToday();
  const r = resolve_plan_day(dateParam, today);
  if (r.date === null) return json({ error: r.note }, 400, NO_STORE);

  const { data: plan } = await readDoc(env, 'kaoyan');
  const { slots, note } = day_plan(plan || {}, r.date);

  const { data: profile } = await readDoc(env, 'agent_profile');
  const sched = (profile && profile.schedule) || {};
  const wake = sched.wake || '08:00';
  const sleep = sched.sleep || '23:30';

  const occupied = slots
    .map(s => [toMin(s && s.start), toMin(s && s.end)])
    .filter(([a, b]) => a !== null && b !== null && b > a)
    .sort((a, b) => a[0] - b[0]);
  const free = [];
  let cursor = toMin(wake);
  for (const [a, b] of occupied) {
    if (b <= toMin(wake) || a >= toMin(sleep)) continue;
    const ca = Math.max(a, toMin(wake)), cb = Math.min(b, toMin(sleep));
    if (ca > cursor) free.push([cursor, ca]);
    cursor = Math.max(cursor, cb);
  }
  if (cursor < toMin(sleep)) free.push([cursor, toMin(sleep)]);

  const nowHHMM = r.date === today ? shanghaiNowHHMM() : null;
  return json({
    ok: true,
    date: r.date,
    dateLabel: r.note,
    slots,
    note,
    freeWindows: free.map(([a, b]) => [`${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`,
      `${String(Math.floor(b / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}`]),
    rendered: render_day(r.date, slots, note, nowHHMM),
    countdown: countdown_text(plan || {}, today)
  }, 200, NO_STORE);
}

/* ---------------- POST：排期（自动应用） ---------------- */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  if (!body || typeof body !== 'object') return json({ error: '请求体不能为空' }, 400, NO_STORE);

  const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  if (!allocations.length) return json({ error: '需要有 allocations 数组（[{subject, minutes}]）' }, 400, NO_STORE);
  for (const a of allocations) {
    if (!a || typeof a !== 'object' || !String(a.subject || '').trim()) {
      return json({ error: '每条分配都要有 subject' }, 400, NO_STORE);
    }
    const m = Math.round(+a.minutes || 0);
    if (m <= 0 || m > 1440) return json({ error: 'minutes 必须在 1~1440 之间' }, 400, NO_STORE);
  }

  try {
    const r = await applySchedule(env, {
      date: String(body.date || 'today'),
      allocations: allocations.map(a => ({
        subject: String(a.subject).trim(),
        minutes: Math.round(+a.minutes),
        taskId: a.taskId ? String(a.taskId) : undefined,
        topic: a.topic ? String(a.topic) : undefined
      })),
      source: 'api'
    });
    if (r.error) return json({ error: r.error }, 400, NO_STORE);
    return json({ ok: true, ...r }, 200, NO_STORE);
  } catch (e) {
    return json({ error: '排期失败：' + (e.message || e) }, 500, NO_STORE);
  }
}
