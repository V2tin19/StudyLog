/**
 * GET /api/diary —— 公开接口，所有人可读
 *
 * 查询参数（都可省略）：
 *   limit   返回条数，默认 60，最大 200
 *   offset  跳过条数，默认 0（用于「加载更多」）
 *   year    按年筛选，如 2026
 *   month   按月筛选，配合 year 使用，如 9
 *
 * 返回：{ entries: [...], stats: {...}, limit, offset }
 */

import { toEntry, json, dbMissing } from '../_shared.js';

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();

  const url = new URL(request.url);

  /* ---- 分页参数 ---- */
  let limit = parseInt(url.searchParams.get('limit') || '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  let offset = parseInt(url.searchParams.get('offset') || '', 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  /* ---- 条件 ---- */
  const where = ["content != ''"];
  const params = [];

  const year = (url.searchParams.get('year') || '').trim();
  const month = (url.searchParams.get('month') || '').trim();

  if (/^\d{4}$/.test(year)) {
    if (/^\d{1,2}$/.test(month)) {
      const mm = String(Number(month)).padStart(2, '0');
      where.push('date LIKE ?');
      params.push(`${year}-${mm}-%`);
    } else {
      where.push('date LIKE ?');
      params.push(`${year}-%`);
    }
  }

  const whereSql = where.join(' AND ');

  try {
    const { results } = await env.DB
      .prepare(`SELECT * FROM diary WHERE ${whereSql} ORDER BY pinned DESC, date DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all();

    const stat = await env.DB
      .prepare("SELECT COUNT(*) AS total, MIN(date) AS first_date, MAX(date) AS last_date FROM diary WHERE content != ''")
      .first();

    return json(
      {
        entries: (results || []).map(toEntry),
        stats: {
          total: stat?.total || 0,
          firstDate: stat?.first_date || '',
          lastDate: stat?.last_date || ''
        },
        limit,
        offset
      },
      200,
      { 'cache-control': 'public, max-age=60' }
    );
  } catch (err) {
    return json({ error: '读取失败：' + err.message }, 500, { 'cache-control': 'no-store' });
  }
}
