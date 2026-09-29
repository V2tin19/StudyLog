/**
 * /api/admin/comments —— 留言管理（需要令牌）
 *
 *   GET    /api/admin/comments              列出全部（含已隐藏），带黑名单
 *          ?limit=&offset=&filter=all|diary|board|hidden
 *   PATCH  /api/admin/comments              隐藏 / 恢复
 *          body: { id, hidden: true|false }
 *   POST   /api/admin/comments              拉黑
 *          body: { ipHash }
 *   DELETE /api/admin/comments?id=          彻底删除某条
 *   DELETE /api/admin/comments?ipHash=      解除拉黑
 *
 * 「隐藏」是软删除：只改 hidden，记录留着 —— 删错了能恢复，也能看出是谁在捣乱。
 * 「删除」是真删，给那种必须清掉的场景。
 */

import { json, dbMissing, requireAdmin, isMissingTable, isMissingColumn, blockIp, unblockIp, BLOCKLIST_TABLE } from '../_shared.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const NO_STORE = { 'cache-control': 'no-store' };

const NEED_TABLE = '留言表还没建。请在 D1 控制台执行 schema.sql 里 comments / comment_blocklist 那两段。';

function toAdminComment(row) {
  return {
    id: row.id,
    scope: row.scope,
    target: row.target || '',
    name: row.name || '',
    content: row.content || '',
    createdAt: row.created_at || '',
    hidden: !!row.hidden,
    ipHash: row.ip_hash || '',
    reply: row.reply || '',
    replyAt: row.reply_at || '',
    location: row.location || ''
  };
}

/* ---------------- GET：列表 ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const url = new URL(request.url);
  const filter = (url.searchParams.get('filter') || 'all').trim();

  let limit = parseInt(url.searchParams.get('limit') || '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  let offset = parseInt(url.searchParams.get('offset') || '', 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const where = [];
  const params = [];
  if (filter === 'diary' || filter === 'board') {
    where.push('scope = ?');
    params.push(filter);
  } else if (filter === 'hidden') {
    where.push('hidden = 1');
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  try {
    const { results } = await env.DB
      .prepare(`SELECT * FROM comments${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit + 1, offset)
      .all();

    const rows = results || [];
    const hasMore = rows.length > limit;

    const stat = await env.DB
      .prepare('SELECT COUNT(*) AS total, SUM(hidden) AS hidden FROM comments')
      .first();

    let filteredTotal = (stat && stat.total) || 0;
    if (where.length) {
      const f = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM comments${whereSql}`)
        .bind(...params)
        .first();
      filteredTotal = (f && f.n) || 0;
    }

    /* 表可能建了 comments 但没建 blocklist（分开跑的），所以单独兜底 */
    let blocked = [];
    try {
      const b = await env.DB
        .prepare(`SELECT ip_hash, created_at FROM ${BLOCKLIST_TABLE} ORDER BY created_at DESC`)
        .all();
      blocked = (b.results || []).map(r => ({ ipHash: r.ip_hash, createdAt: r.created_at }));
    } catch { /* 黑名单表还没建，当作空 */ }

    return json(
      {
        ok: true,
        comments: rows.slice(0, limit).map(toAdminComment),
        hasMore,
        total: (stat && stat.total) || 0,
        filteredTotal,
        hiddenCount: (stat && stat.hidden) || 0,
        blocked
      },
      200,
      NO_STORE
    );
  } catch (err) {
    if (isMissingTable(err)) {
      return json({ ok: true, needTable: true, comments: [], hasMore: false, total: 0, filteredTotal: 0, hiddenCount: 0, blocked: [] }, 200, NO_STORE);
    }
    return json({ error: '读取留言失败：' + err.message }, 500, NO_STORE);
  }
}

/* ---------------- PATCH：隐藏 / 恢复 / 回复 ---------------- */
export async function onRequestPatch({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE);
  }

  const id = parseInt(body && body.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return json({ error: '缺少有效的留言 id' }, 400, NO_STORE);
  }

  try {
    const sets = [];
    const params = [];
    const out = { ok: true, id };

    if (body && body.hidden !== undefined) {
      const hidden = body.hidden ? 1 : 0;
      sets.push('hidden = ?');
      params.push(hidden);
      out.hidden = !!hidden;
    }

    if (body && body.reply !== undefined) {
      const reply = String(body.reply || '').trim().slice(0, 1000);
      const replyAt = reply ? new Date().toISOString() : '';
      sets.push('reply = ?');
      params.push(reply);
      sets.push('reply_at = ?');
      params.push(replyAt);
      out.reply = reply;
      out.replyAt = replyAt;
    }

    if (!sets.length) {
      return json({ error: '没有需要更新的字段' }, 400, NO_STORE);
    }

    params.push(id);
    await env.DB.prepare(`UPDATE comments SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
    return json(out, 200, NO_STORE);
  } catch (err) {
    if (isMissingTable(err)) return json({ error: NEED_TABLE }, 500, NO_STORE);
    if (isMissingColumn(err)) {
      return json({ error: '留言表缺少 reply 或 reply_at 字段，请在 D1 执行：ALTER TABLE comments ADD COLUMN reply TEXT NOT NULL DEFAULT \'\'; ALTER TABLE comments ADD COLUMN reply_at TEXT NOT NULL DEFAULT \'\';' }, 500, NO_STORE);
    }
    return json({ error: '修改失败：' + err.message }, 500, NO_STORE);
  }
}

/* ---------------- POST：拉黑 ----------------
   注意：「拉黑」不只挡留言，也挡书目荐读 —— 两边共用同一张黑名单表。
   对一个被拉黑的人来说，他看到的应该是「这个地址发不出任何东西」。 */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE);
  }

  const ipHash = String((body && body.ipHash) || '').trim();
  if (!/^[0-9a-f]{16,64}$/i.test(ipHash)) {
    return json({ error: 'ipHash 格式不对' }, 400, NO_STORE);
  }

  try {
    await blockIp(env, ipHash);
    return json({ ok: true, ipHash }, 200, NO_STORE);
  } catch (err) {
    if (isMissingTable(err)) return json({ error: NEED_TABLE }, 500, NO_STORE);
    return json({ error: '拉黑失败：' + err.message }, 500, NO_STORE);
  }
}

/* ---------------- DELETE：删一条 / 解除拉黑 ---------------- */
export async function onRequestDelete({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const url = new URL(request.url);
  const idRaw = url.searchParams.get('id');
  const ipHash = (url.searchParams.get('ipHash') || '').trim();

  try {
    if (idRaw) {
      const id = parseInt(idRaw, 10);
      if (!Number.isFinite(id) || id <= 0) return json({ error: '缺少有效的留言 id' }, 400, NO_STORE);
      await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
      return json({ ok: true, deleted: id }, 200, NO_STORE);
    }

    if (ipHash) {
      await unblockIp(env, ipHash);
      return json({ ok: true, unblocked: ipHash }, 200, NO_STORE);
    }

    return json({ error: '要删留言传 id，要解除拉黑传 ipHash' }, 400, NO_STORE);
  } catch (err) {
    if (isMissingTable(err)) return json({ error: NEED_TABLE }, 500, NO_STORE);
    return json({ error: '删除失败：' + err.message }, 500, NO_STORE);
  }
}
