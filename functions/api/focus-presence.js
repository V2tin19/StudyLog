/**
 * /api/focus-presence —— 在线自习室伴读状态同步
 *
 *   GET  /api/focus-presence
 *        → { ok: true, active: [...], count: N }
 *
 *   POST /api/focus-presence
 *        body: { id, name, subject, mode, targetMinutes, startTime, action }
 *        action: 'heartbeat' | 'leave'
 *        → { ok: true, active: [...], count: N }
 *
 * 数据利用 D1 的 site_meta 表（key='focus_presence_list'），
 * 超时 25 分钟无心跳自动判定为离线，零迁移开箱即用。
 */

import { json, dbMissing, honeyPotHit } from './_shared.js';

const NO_STORE = { 'cache-control': 'no-store' };
const CACHE = { 'cache-control': 'public, max-age=5' };
const TIMEOUT_MS = 25 * 60 * 1000; /* 25 分钟无心跳视为离线 */

export async function onRequestGet({ env }) {
  if (!env.DB) return dbMissing();

  try {
    const row = await env.DB
      .prepare("SELECT value FROM site_meta WHERE key = 'focus_presence_list'")
      .first();

    let list = [];
    try { list = JSON.parse((row && row.value) || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];

    const now = Date.now();
    const active = list.filter(item => item && (now - (item.updatedAt || 0) < TIMEOUT_MS));

    return json({ ok: true, active, count: active.length }, 200, CACHE);
  } catch (err) {
    return json({ ok: true, active: [], count: 0 }, 200, NO_STORE);
  }
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();

  let body;
  try { body = await request.json(); } catch { body = {}; }
  if (honeyPotHit(body)) return json({ ok: true, active: [] }, 200, NO_STORE);

  const id = String(body.id || '').trim();
  if (!id) return json({ ok: false, error: '缺少会话标识' }, 400, NO_STORE);

  const action = body.action || 'heartbeat';
  const name = String(body.name || '').slice(0, 20);
  const subject = String(body.subject || '自习').slice(0, 30);
  const mode = body.mode === 'countdown' ? 'countdown' : 'countup';
  const targetMinutes = parseInt(body.targetMinutes, 10) || 25;
  const startTime = parseInt(body.startTime, 10) || Date.now();
  const now = Date.now();

  try {
    const row = await env.DB
      .prepare("SELECT value FROM site_meta WHERE key = 'focus_presence_list'")
      .first();

    let list = [];
    try { list = JSON.parse((row && row.value) || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];

    // 剔除超时与本用户的旧记录
    list = list.filter(item => item && (now - (item.updatedAt || 0) < TIMEOUT_MS) && item.id !== id);

    if (action !== 'leave') {
      list.push({
        id,
        name,
        subject,
        mode,
        targetMinutes,
        startTime,
        updatedAt: now
      });
    }

    // 最多保留 60 个活跃用户，防止体积过大
    if (list.length > 60) list = list.slice(-60);

    const payload = JSON.stringify(list);
    try {
      await env.DB.prepare(
        `INSERT INTO site_meta (key, value) VALUES ('focus_presence_list', ?)
         ON CONFLICT(key) DO UPDATE SET value = ?`
      ).bind(payload, payload).run();
    } catch (dbErr) {
      try {
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')").run();
        await env.DB.prepare(
          `INSERT INTO site_meta (key, value) VALUES ('focus_presence_list', ?)
           ON CONFLICT(key) DO UPDATE SET value = ?`
        ).bind(payload, payload).run();
      } catch (e2) {
        // 忽略异常，不阻断前端自习
      }
    }

    return json({ ok: true, active: list, count: list.length }, 200, NO_STORE);
  } catch (err) {
    return json({ ok: false, error: '同步在线状态失败：' + err.message }, 500, NO_STORE);
  }
}
