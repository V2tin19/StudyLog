/**
 * GET /api/diary/:date —— 公开接口，读某一天的日记
 * 例：/api/diary/2026-09-27
 */

import { toEntry, json, dbMissing, isValidDate } from '../_shared.js';

export async function onRequestGet({ env, params }) {
  if (!env.DB) return dbMissing();

  const date = String(params.date || '').trim();
  if (!isValidDate(date)) {
    return json({ error: '日期格式应为 YYYY-MM-DD' }, 400, { 'cache-control': 'no-store' });
  }

  try {
    const row = await env.DB
      .prepare('SELECT * FROM diary WHERE date = ?')
      .bind(date)
      .first();

    if (!row) {
      return json({ error: '没有这一天的记录' }, 404, { 'cache-control': 'no-store' });
    }

    return json({ entry: toEntry(row) }, 200, { 'cache-control': 'public, max-age=60' });
  } catch (err) {
    return json({ error: '读取失败：' + err.message }, 500, { 'cache-control': 'no-store' });
  }
}
