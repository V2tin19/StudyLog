/**
 * /api/admin/agent/profile —— 习惯画像读写口
 *
 *   GET  /api/admin/agent/profile       画像（habits 聚合结果 + prefs + schedule 配置）
 *   PUT  /api/admin/agent/profile       body: { prefs?: [..], schedule?: {wake,sleep,weeklyTargetMinutes} }
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 *
 * habits 由 /api/admin/agent/learn 夜间聚合写入；prefs 是用户/助手沉淀的
 * 偏好语句（可编辑）；schedule 是排期引擎的作息边界。
 * 画像会注入排期引擎（subjectWindows 偏好窗）与推送时机（actualStartTime）。
 */

import { json, dbMissing, requireAdmin } from '../../_shared.js';
import { readDoc, writeDoc, nowIso } from '../../agent/_store.js';

const NO_STORE = { 'cache-control': 'no-store' };

function defaultProfile() {
  return {
    habits: {},
    prefs: [],
    schedule: { wake: '08:00', sleep: '23:30', weeklyTargetMinutes: 2940 },
    updatedAt: ''
  };
}

export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const { data } = await readDoc(env, 'agent_profile');
  const p = data && typeof data === 'object' ? data : defaultProfile();
  return json({
    ok: true,
    habits: p.habits || {},
    prefs: Array.isArray(p.prefs) ? p.prefs : [],
    schedule: p.schedule || defaultProfile().schedule,
    updatedAt: p.updatedAt || ''
  }, 200, NO_STORE);
}

export async function onRequestPut({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  if (!body || typeof body !== 'object') return json({ error: '请求体不能为空' }, 400, NO_STORE);

  const { data } = await readDoc(env, 'agent_profile');
  const p = data && typeof data === 'object' ? data : defaultProfile();

  if (body.prefs !== undefined) {
    if (!Array.isArray(body.prefs)) return json({ error: 'prefs 必须是字符串数组' }, 400, NO_STORE);
    p.prefs = body.prefs.slice(0, 30).map(s => String(s).slice(0, 100));
  }
  if (body.schedule !== undefined) {
    const s = body.schedule || {};
    const cur = p.schedule || defaultProfile().schedule;
    p.schedule = {
      wake: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.wake || '')) ? s.wake : cur.wake,
      sleep: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.sleep || '')) ? s.sleep : cur.sleep,
      weeklyTargetMinutes: Math.max(60, Math.min(8400, Math.round(+s.weeklyTargetMinutes || cur.weeklyTargetMinutes || 2940)))
    };
  }
  p.updatedAt = nowIso();
  await writeDoc(env, 'agent_profile', p);
  return json({ ok: true, profile: { habits: p.habits, prefs: p.prefs, schedule: p.schedule, updatedAt: p.updatedAt } }, 200, NO_STORE);
}
