/**
 * 「访客推荐 → 站主审核 → 自动进清单」这一类接口的公用实现。
 *
 * 书目荐读（book_suggestions）和目标推荐（goal_suggestions）是同一个东西的两次应用：
 *
 *   公开：GET  已通过的（上墙）        POST 访客提交
 *   站主：GET  列表+计数   PATCH 通过/不要/标记已入库
 *         POST 拉黑       DELETE 彻底删
 *
 * 差别只有表名和几句文案，全部塞进 cfg。**防护逻辑一个字都不重复** ——
 * 第二份手抄的防护迟早会跟第一份走偏，而走偏的那边就是缺口。
 *
 * ⚠️ 两张表的字段刻意保持一致：目标没有「作者」这一栏，goal_suggestions 的
 *    author 恒为空串。用一列换来「这个文件里一个 if 分支都不用写」，很划算。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么「进清单」不是服务端做的？
 *
 * 书单 / 目标清单都躺在 doc 表的那一行 JSON 里，而写作台的同步策略是
 * 「云端为主存，谁 updatedAt 新谁赢」。服务端要是直接改那份 JSON，写作台手上
 * 「改过但还没推上去」的旧版本下一次同步就会把它覆盖掉，而且悄无声息。
 * 所以边界划在：服务端只管审核状态（本文件），搬进清单由写作台做。
 * imported_at 是兜底 —— 审核时写作台可能没开着，下次打开能补收。
 * ────────────────────────────────────────────────────────────
 */

import {
  json, dbMissing, requireAdmin, isMissingTable,
  hashIp, clientIp, honeyPotHit, hasLink, isBlocked, isRateLimited, blockIp
} from './_shared.js';

const NO_STORE = { 'cache-control': 'no-store' };

const LIST_DEFAULT = 30;
const LIST_MAX = 100;
const ADMIN_DEFAULT = 50;
const ADMIN_MAX = 200;

/* 两道限流叠加：一道防脚本猛刷，一道防慢慢磨 */
const RATE_FAST_MAX = 3;
const RATE_FAST_WINDOW = 60 * 1000;
const RATE_SLOW_MAX = 20;
const RATE_SLOW_WINDOW = 24 * 60 * 60 * 1000;

const FILTER_SQL = {
  all: '',
  pending: " WHERE status = 'pending'",
  approved: " WHERE status = 'approved'",
  rejected: " WHERE status = 'rejected'"
};

/** 前端只会传这三个，其余一律拒 —— 别让状态字段被写成乱七八糟的值 */
const ACTIONS = ['approve', 'reject', 'imported'];

const COLS = 'id, title, author, note, name, status, created_at, decided_at, imported_at, ip_hash';

/** 公开接口只给这几个字段，绝不带 ip_hash / status 出去 */
function toItem(row) {
  return {
    id: row.id,
    title: row.title || '',
    author: row.author || '',
    note: row.note || '',
    name: row.name || '',
    createdAt: row.created_at || ''
  };
}

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

/* ============================================================
   公开接口（任何人可读，访客可写）
   ============================================================ */

export function makePublicApi(cfg) {
  const { table, titleMax, titleMsg, needTable } = cfg;

  async function onRequestGet({ env, request }) {
    if (!env.DB) return dbMissing();

    const url = new URL(request.url);

    let limit = parseInt(url.searchParams.get('limit') || '', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = LIST_DEFAULT;
    limit = Math.min(limit, LIST_MAX);

    let offset = parseInt(url.searchParams.get('offset') || '', 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    try {
      /* 多取一条来判断「还有没有更早的」，省掉一次 COUNT */
      const { results } = await env.DB
        .prepare(
          `SELECT ${COLS} FROM ${table}
           WHERE status = 'approved'
           ORDER BY id DESC LIMIT ? OFFSET ?`
        )
        .bind(limit + 1, offset)
        .all();

      const rows = results || [];
      const hasMore = rows.length > limit;

      return json({ ok: true, items: rows.slice(0, limit).map(toItem), hasMore }, 200, NO_STORE);
    } catch (err) {
      /* 表没建不要报错 —— 页面本身是好的，不显示这一块就行。
         否则访客看到的是「页面坏了」，而实际上只是站主少跑了一段 SQL。 */
      if (isMissingTable(err)) return json({ ok: true, items: [], hasMore: false, needTable: true }, 200, NO_STORE);
      return json({ error: '读取失败：' + err.message }, 500, NO_STORE);
    }
  }

  async function onRequestPost({ env, request }) {
    if (!env.DB) return dbMissing();

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE);
    }

    /* ---- 1. 蜜罐 ----
       假设成功、不写库：让机器人以为提交进去了，别给它反馈去调参。 */
    if (honeyPotHit(body)) {
      return json({ ok: true, item: null }, 200, NO_STORE);
    }

    /* ---- 2. 内容校验 ---- */
    const title = String((body && body.title) || '').trim().slice(0, titleMax);
    const author = String((body && body.author) || '').trim().slice(0, 40);
    const note = String((body && body.note) || '').trim().slice(0, 200);
    const name = String((body && body.name) || '').trim().slice(0, 24);

    if (!title) return json({ error: titleMsg }, 400, NO_STORE);

    /* 垃圾内容几乎 100% 带链接。三个字段都查，别只查正文 ——
       把链接藏进标题或者「作者」里是最常见的绕法。 */
    if (hasLink(title) || hasLink(author) || hasLink(note)) {
      return json({ error: '内容里不能带链接' }, 400, NO_STORE);
    }

    const ipHash = await hashIp(clientIp(request), env.COMMENT_SALT);

    try {
      /* ---- 3. 拉黑名单（跟留言共用一张表） ---- */
      if (await isBlocked(env, ipHash)) {
        return json({ error: '这个网络地址已被站主拉黑' }, 403, NO_STORE);
      }

      /* ---- 4. 限流 ---- */
      if (await isRateLimited(env, table, ipHash, RATE_FAST_MAX, RATE_FAST_WINDOW)) {
        return json({ error: `提得太快了，一分钟最多 ${RATE_FAST_MAX} 条` }, 429, NO_STORE);
      }
      if (await isRateLimited(env, table, ipHash, RATE_SLOW_MAX, RATE_SLOW_WINDOW)) {
        return json({ error: `今天提得有点多（上限 ${RATE_SLOW_MAX} 条），明天再来` }, 429, NO_STORE);
      }

      const createdAt = new Date().toISOString();
      const res = await env.DB
        .prepare(
          `INSERT INTO ${table} (title, author, note, name, status, created_at, decided_at, imported_at, ip_hash)
           VALUES (?, ?, ?, ?, 'pending', ?, '', '', ?)`
        )
        .bind(title, author, note, name, createdAt, ipHash)
        .run();

      return json(
        {
          ok: true,
          item: {
            id: (res.meta && res.meta.last_row_id) || 0,
            title, author, note, name, createdAt
          }
        },
        200,
        NO_STORE
      );
    } catch (err) {
      if (isMissingTable(err)) return json({ error: needTable }, 500, NO_STORE);
      return json({ error: '提交失败：' + err.message }, 500, NO_STORE);
    }
  }

  return { onRequestGet, onRequestPost };
}

/* ============================================================
   站主审核接口（需要令牌）
   ============================================================ */

export function makeAdminApi(cfg) {
  const { table, needTable } = cfg;

  async function onRequestGet({ env, request }) {
    if (!env.DB) return dbMissing();
    const rejected = requireAdmin(request, env);
    if (rejected) return rejected;

    const url = new URL(request.url);
    const filter = (url.searchParams.get('filter') || 'all').trim();
    const where = FILTER_SQL[filter] === undefined ? '' : FILTER_SQL[filter];

    let limit = parseInt(url.searchParams.get('limit') || '', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = ADMIN_DEFAULT;
    limit = Math.min(limit, ADMIN_MAX);

    let offset = parseInt(url.searchParams.get('offset') || '', 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    try {
      const { results } = await env.DB
        .prepare(`SELECT ${COLS} FROM ${table}${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .bind(limit + 1, offset)
        .all();

      const rows = results || [];
      const hasMore = rows.length > limit;

      /* 一次 GROUP BY 拿到三类计数，写作台侧栏不用发第二个请求 */
      const stat = await env.DB
        .prepare(`SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`)
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
      return json({ error: '读取失败：' + err.message }, 500, NO_STORE);
    }
  }

  async function onRequestPatch({ env, request }) {
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

    if (!Number.isFinite(id) || id <= 0) return json({ error: '缺少有效的 id' }, 400, NO_STORE);
    if (ACTIONS.indexOf(action) === -1) {
      return json({ error: 'action 只能是 ' + ACTIONS.join(' / ') }, 400, NO_STORE);
    }

    const now = new Date().toISOString();

    try {
      if (action === 'imported') {
        /* 只有已通过的才谈得上「已入库」。顺手挡一下，
           免得前端状态错乱时给一条 pending 打上入库时间戳。 */
        const row = await env.DB
          .prepare(`SELECT status FROM ${table} WHERE id = ?`)
          .bind(id)
          .first();
        if (!row) return json({ error: '没有这一条' }, 404, NO_STORE);
        if (row.status !== 'approved') {
          return json({ error: '这条还没通过审核，不能标记为已入库' }, 409, NO_STORE);
        }

        await env.DB
          .prepare(`UPDATE ${table} SET imported_at = ? WHERE id = ?`)
          .bind(now, id)
          .run();
        return json({ ok: true, id, importedAt: now }, 200, NO_STORE);
      }

      /* approve / reject：都在这里落 decided_at。
         通过之后再「不要」也允许 —— 站主有权改主意（清单里那条要自己删）。 */
      const status = action === 'approve' ? 'approved' : 'rejected';
      await env.DB
        .prepare(`UPDATE ${table} SET status = ?, decided_at = ? WHERE id = ?`)
        .bind(status, now, id)
        .run();

      return json({ ok: true, id, status, decidedAt: now }, 200, NO_STORE);
    } catch (err) {
      if (isMissingTable(err)) return json({ error: needTable }, 500, NO_STORE);
      return json({ error: '修改失败：' + err.message }, 500, NO_STORE);
    }
  }

  /* 拉黑。跟留言共用同一张黑名单表（见 _shared.js 的 BLOCKLIST_TABLE）。
     解除拉黑在「留言」页做 —— 那里是黑名单的统一出口，不必两处都能改。 */
  async function onRequestPost({ env, request }) {
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
      if (isMissingTable(err)) return json({ error: needTable }, 500, NO_STORE);
      return json({ error: '拉黑失败：' + err.message }, 500, NO_STORE);
    }
  }

  async function onRequestDelete({ env, request }) {
    if (!env.DB) return dbMissing();
    const rejected = requireAdmin(request, env);
    if (rejected) return rejected;

    const id = parseInt(new URL(request.url).searchParams.get('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return json({ error: '缺少有效的 id' }, 400, NO_STORE);

    try {
      await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
      return json({ ok: true, deleted: id }, 200, NO_STORE);
    } catch (err) {
      if (isMissingTable(err)) return json({ error: needTable }, 500, NO_STORE);
      return json({ error: '删除失败：' + err.message }, 500, NO_STORE);
    }
  }

  return { onRequestGet, onRequestPatch, onRequestPost, onRequestDelete };
}
