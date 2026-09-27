/**
 * /api/admin/suggestions —— 书目荐读的审核（需要令牌）
 *
 *   GET    /api/admin/suggestions?filter=all|pending|approved|rejected
 *   PATCH  /api/admin/suggestions
 *          body: { id, action: 'approve' | 'reject' | 'imported' }
 *   POST   /api/admin/suggestions           拉黑
 *          body: { ipHash }
 *   DELETE /api/admin/suggestions?id=       彻底删掉一条
 *
 * 三个 action：
 *   approve   —— 通过，公开页的荐读墙会出现它
 *   reject    —— 不要
 *   imported  —— 「这本书已经搬进站主的书单了」，记一个时间戳
 *
 * ────────────────────────────────────────────────────────────
 * 为什么「进书单」不是服务端做的？
 *
 * 站主的书单存在 doc 表的 study 那一行 JSON 里，而写作台的同步策略是
 * 「云端为主存，谁 updatedAt 新谁赢」。如果服务端在审核通过时直接改
 * doc.study 的 payload，而写作台本地刚好有一份「改过但还没推上去」的
 * 学习数据（时间戳更新），那它下一次同步就会把自己的旧版本推上去，
 * **把服务端刚加进去的那本书覆盖掉** —— 而且悄无声息。
 *
 * 所以边界划在这里：
 *   · 服务端只负责「审核状态」这一件事（本文件）
 *   · 「搬进书单」由写作台做：它本来就在读写 doc.study，走的是既有的同步链路，
 *     不存在两方同时写同一份 JSON 的竞态
 *
 * imported_at 就是为此存在的兜底：要是通过审核的时候写作台没开着，
 * 那本书会停在「已通过但还没入库」的状态，写作台下次打开能看见并补收。
 * ────────────────────────────────────────────────────────────
 */

import { json, dbMissing, requireAdmin, isMissingTable, blockIp } from '../_shared.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const NO_STORE = { 'cache-control': 'no-store' };

const NEED_TABLE = '荐读表还没建。请在 D1 控制台执行 schema.sql 里 book_suggestions 那一段。';

/** 前端只会传这三个，其余一律拒 —— 别让状态字段被写成乱七八糟的值 */
const ACTIONS = ['approve', 'reject', 'imported'];

const FILTER_SQL = {
  all: '',
  pending: " WHERE status = 'pending'",
  approved: " WHERE status = 'approved'",
  rejected: " WHERE status = 'rejected'"
};

function toAdminItem(row) {
  return {
    id: row.id,
    title: row.title || '',
    author: row.author || '',
    note: row.note || '',
    name: row.name || '',
    status: row.status || 'pending',
    createdAt: row.created_at || '',
    decidedAt: row.decided_at || '',
    importedAt: row.imported_at || '',
    ipHash: row.ip_hash || ''
  };
}

/* ---------------- GET：列表 + 各类计数 ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const url = new URL(request.url);
  const filter = (url.searchParams.get('filter') || 'all').trim();
  const where = FILTER_SQL[filter] === undefined ? '' : FILTER_SQL[filter];

  let limit = parseInt(url.searchParams.get('limit') || '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  let offset = parseInt(url.searchParams.get('offset') || '', 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  try {
    const { results } = await env.DB
      .prepare(`SELECT * FROM book_suggestions${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(limit + 1, offset)
      .all();

    const rows = results || [];
    const hasMore = rows.length > limit;

    /* 一次 GROUP BY 拿到三类计数，写作台侧栏不用发第二个请求 */
    const stat = await env.DB
      .prepare('SELECT status, COUNT(*) AS n FROM book_suggestions GROUP BY status')
      .all();

    const counts = { pending: 0, approved: 0, rejected: 0 };
    (stat.results || []).forEach(r => {
      if (counts[r.status] !== undefined) counts[r.status] = r.n;
    });

    return json(
      {
        ok: true,
        items: rows.slice(0, limit).map(toAdminItem),
        hasMore,
        counts,
        total: counts.pending + counts.approved + counts.rejected
      },
      200,
      NO_STORE
    );
  } catch (err) {
    if (isMissingTable(err)) {
      return json(
        { ok: true, needTable: true, items: [], hasMore: false, counts: { pending: 0, approved: 0, rejected: 0 }, total: 0 },
        200,
        NO_STORE
      );
    }
    return json({ error: '读取荐读失败：' + err.message }, 500, NO_STORE);
  }
}

/* ---------------- PATCH：通过 / 拒绝 / 标记已入库 ---------------- */
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
  const action = String((body && body.action) || '').trim();

  if (!Number.isFinite(id) || id <= 0) {
    return json({ error: '缺少有效的荐读 id' }, 400, NO_STORE);
  }
  if (ACTIONS.indexOf(action) === -1) {
    return json({ error: 'action 只能是 ' + ACTIONS.join(' / ') }, 400, NO_STORE);
  }

  const now = new Date().toISOString();

  try {
    if (action === 'imported') {
      /* 只有已通过的才谈得上「已入库」。顺手挡一下，
         免得前端状态错乱时给一条 pending 打上入库时间戳。 */
      const row = await env.DB
        .prepare('SELECT status FROM book_suggestions WHERE id = ?')
        .bind(id)
        .first();
      if (!row) return json({ error: '没有这条荐读' }, 404, NO_STORE);
      if (row.status !== 'approved') {
        return json({ error: '这条还没通过审核，不能标记为已入库' }, 409, NO_STORE);
      }

      await env.DB
        .prepare('UPDATE book_suggestions SET imported_at = ? WHERE id = ?')
        .bind(now, id)
        .run();
      return json({ ok: true, id, importedAt: now }, 200, NO_STORE);
    }

    /* approve / reject：都在这里落 decided_at。
       通过之后再「拒绝」也允许 —— 站主有权改主意（书单里那本要自己删）。 */
    const status = action === 'approve' ? 'approved' : 'rejected';
    await env.DB
      .prepare('UPDATE book_suggestions SET status = ?, decided_at = ? WHERE id = ?')
      .bind(status, now, id)
      .run();

    return json({ ok: true, id, status, decidedAt: now }, 200, NO_STORE);
  } catch (err) {
    if (isMissingTable(err)) return json({ error: NEED_TABLE }, 500, NO_STORE);
    return json({ error: '修改失败：' + err.message }, 500, NO_STORE);
  }
}

/* ---------------- POST：拉黑 ----------------
   跟留言共用同一张黑名单表（见 _shared.js 的 BLOCKLIST_TABLE）。
   解除拉黑在「留言」页做 —— 那里是黑名单的统一出口，不必两处都能改。 */
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

/* ---------------- DELETE：彻底删一条 ---------------- */
export async function onRequestDelete({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const idRaw = new URL(request.url).searchParams.get('id');
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return json({ error: '缺少有效的荐读 id' }, 400, NO_STORE);
  }

  try {
    await env.DB.prepare('DELETE FROM book_suggestions WHERE id = ?').bind(id).run();
    return json({ ok: true, deleted: id }, 200, NO_STORE);
  } catch (err) {
    if (isMissingTable(err)) return json({ error: NEED_TABLE }, 500, NO_STORE);
    return json({ error: '删除失败：' + err.message }, 500, NO_STORE);
  }
}
