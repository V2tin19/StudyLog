/**
 * /api/admin/agent/logs —— 量化日志读写口
 *
 *   GET  /api/admin/agent/logs?days=30     最近 N 天日志（agent_logs doc）
 *   POST /api/admin/agent/logs             body: { date?, raw } → 构建并保存一天日志
 *                                            （metrics 代码算，AI 补全；重复 POST 覆盖）
 *   DELETE /api/admin/agent/logs?date=     删一天日志
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 */

import { json, dbMissing, requireAdmin, isValidDate } from '../../_shared.js';
import { shanghaiToday } from '../../agent/_nlu.js';
import { buildDayLog, readLogs, deleteLog, saveLog } from '../../agent/_logs.js';

const NO_STORE = { 'cache-control': 'no-store' };

/* ---------------- GET ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const days = Math.min(Math.max(parseInt(new URL(request.url).searchParams.get('days') || '30', 10) || 30, 1), 365);
  const logs = await readLogs(env, days);
  return json({ ok: true, days, logs }, 200, NO_STORE);
}

/* ---------------- POST：构建并保存 ---------------- */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  const raw = String((body && body.raw) || '').trim();
  const date = String((body && body.date) || shanghaiToday());
  if (!raw) return json({ error: '需要有 raw 字段（一句原话就够）' }, 400, NO_STORE);
  if (!isValidDate(date)) return json({ error: 'date 必须是 YYYY-MM-DD' }, 400, NO_STORE);

  try {
    const { log } = await buildDayLog(env, { date, raw, source: 'api' });
    await saveLog(env, date, log);
    return json({ ok: true, date, log }, 200, NO_STORE);
  } catch (e) {
    return json({ error: e.message || String(e) }, 400, NO_STORE);
  }
}

/* ---------------- DELETE ---------------- */
export async function onRequestDelete({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const date = new URL(request.url).searchParams.get('date') || '';
  if (!isValidDate(date)) return json({ error: 'date 必须是 YYYY-MM-DD' }, 400, NO_STORE);
  const removed = await deleteLog(env, date);
  if (!removed) return json({ error: '这天还没有日志' }, 404, NO_STORE);
  return json({ ok: true, deleted: date }, 200, NO_STORE);
}
