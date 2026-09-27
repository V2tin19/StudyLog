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
    /* 表还没建的情况：给一句人能看懂的话，别抛 500 让前端猜 */
    return json(
      { error: '数据表 doc 还没建。请到 Cloudflare D1 控制台执行 schema.sql 里新增的那条 CREATE TABLE 语句' },
      500,
      { 'cache-control': 'no-store' }
    );
  }

  const docs = {};
  results.forEach(row => {
    let data = null;
    try { data = JSON.parse(row.payload || 'null'); } catch { data = null; }
    if (data !== null) docs[row.key] = { data, updatedAt: row.updated_at || '' };
  });

  return json({ ok: true, docs }, 200, { 'cache-control': 'public, max-age=60' });
}
