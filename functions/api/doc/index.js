/**
 * /api/doc —— 公开读取「展示型」数据（学习 / 日程 / 目标）
 *
 *   GET /api/doc
 *   → { ok: true, docs: { study: { data, updatedAt }, schedule: {...}, goals: {...} } }
 *
 * 这些数据本来就是给朋友看的，所以读不需要令牌。
 * 写入在 /api/admin/doc，那里才校验令牌。
 */

import { json, dbMissing } from '../_shared.js';

export async function onRequestGet({ env }) {
  if (!env.DB) return dbMissing();

  let results = [];
  try {
    const r = await env.DB.prepare('SELECT key, payload, updated_at FROM doc').all();
    results = r.results || [];
  } catch (err) {
    /* 表还没建的情况：自动无感建表，免去手动进 D1 控制台执行 SQL */
    try {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS doc (key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')"
      ).run();
      const r = await env.DB.prepare('SELECT key, payload, updated_at FROM doc').all();
      results = r.results || [];
    } catch (e2) {
      /* 兜底返回空对象，绝对不要抛 500 破坏前端页面 */
      return json({ ok: true, docs: {} }, 200, { 'cache-control': 'no-store' });
    }
  }

  const docs = {};
  results.forEach(row => {
    let data = null;
    try { data = JSON.parse(row.payload || 'null'); } catch { data = null; }
    if (data !== null) docs[row.key] = { data, updatedAt: row.updated_at || '' };
  });

  return json({ ok: true, docs }, 200, { 'cache-control': 'public, max-age=60' });
}
