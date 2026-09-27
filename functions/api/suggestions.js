/**
 * /api/suggestions —— 书目荐读（访客可写）
 *
 *   GET  ?limit=&offset=                     已通过的推荐（公开的「荐读墙」）
 *   POST { title, author, note, name, hp }   推荐一本书
 *
 * ⚠️ 这是全站第二个「不需要令牌的写接口」（第一个是 /api/comments）。
 * 防护跟留言共用同一套，见 _shared.js：蜜罐 / 限流 / 链接过滤 / 拉黑名单。
 * 两边的防护必须是同一份实现 —— 各写一份迟早会一边加了规则另一边漏掉。
 *
 * 还有一条边界很重要：**访客提交本身只写 book_suggestions 这张表**，
 * 碰不到 doc（站主的书单）。把推荐搬进书单是站主在写作台点「通过」之后，
 * 由写作台自己做的事。原因见 /api/admin/suggestions.js 的注释。
 */

import {
  json, dbMissing,
  isMissingTable, hashIp, clientIp, honeyPotHit, hasLink, isBlocked, isRateLimited
} from './_shared.js';

const MAX_TITLE = 60;
const MAX_AUTHOR = 40;
const MAX_NOTE = 200;
const MAX_NAME = 24;

const LIST_DEFAULT = 30;
const LIST_MAX = 100;

/* 两道限流叠加：一道防脚本猛刷，一道防慢慢磨。
   「一天最多 20 本」比「一分钟 3 本」更能拦住那种每分钟推一本的机器人。 */
const RATE_FAST_MAX = 3;
const RATE_FAST_WINDOW = 60 * 1000;
const RATE_SLOW_MAX = 20;
const RATE_SLOW_WINDOW = 24 * 60 * 60 * 1000;

const NO_STORE = { 'cache-control': 'no-store' };

const NEED_TABLE = '荐读表还没建。可以在写作台「学习」页的荐读卡片上直接复制建表 SQL，去 D1 控制台跑一次。';

/** 数据库行 → 前端认识的对象。绝不带 ip_hash 出去 */
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

/* ---------------- GET：已通过的推荐 ---------------- */
export async function onRequestGet({ env, request }) {
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
        `SELECT id, title, author, note, name, created_at FROM book_suggestions
         WHERE status = 'approved'
         ORDER BY id DESC LIMIT ? OFFSET ?`
      )
      .bind(limit + 1, offset)
      .all();

    const rows = results || [];
    const hasMore = rows.length > limit;

    return json({ ok: true, items: rows.slice(0, limit).map(toItem), hasMore }, 200, NO_STORE);
  } catch (err) {
    /* 表没建不要报错 —— 学习页本身是好的，不显示荐读区就行。
       否则访客看到的是「学习页坏了」，而实际上只是站主少跑了一段 SQL。 */
    if (isMissingTable(err)) return json({ ok: true, items: [], hasMore: false, needTable: true }, 200, NO_STORE);
    return json({ error: '读取荐读书目失败：' + err.message }, 500, NO_STORE);
  }
}

/* ---------------- POST：推荐一本 ---------------- */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE);
  }

  /* ---- 1. 蜜罐 ----
     假装成功、不写库：让机器人以为提交进去了，别给它反馈去调参。 */
  if (honeyPotHit(body)) {
    return json({ ok: true, item: null }, 200, NO_STORE);
  }

  /* ---- 2. 内容校验 ---- */
  const title = String((body && body.title) || '').trim().slice(0, MAX_TITLE);
  const author = String((body && body.author) || '').trim().slice(0, MAX_AUTHOR);
  const note = String((body && body.note) || '').trim().slice(0, MAX_NOTE);
  const name = String((body && body.name) || '').trim().slice(0, MAX_NAME);

  if (!title) return json({ error: '还没写书名' }, 400, NO_STORE);

  /* 垃圾内容几乎 100% 带链接。三个字段都查，别只查推荐语 ——
     把链接藏进书名或者「作者」里是最常见的绕法。 */
  if (hasLink(title) || hasLink(author) || hasLink(note)) {
    return json({ error: '推荐内容里不能带链接' }, 400, NO_STORE);
  }

  const ipHash = await hashIp(clientIp(request), env.COMMENT_SALT);

  try {
    /* ---- 3. 拉黑名单（跟留言共用） ---- */
    if (await isBlocked(env, ipHash)) {
      return json({ error: '这个网络地址已被站主拉黑' }, 403, NO_STORE);
    }

    /* ---- 4. 限流 ---- */
    if (await isRateLimited(env, 'book_suggestions', ipHash, RATE_FAST_MAX, RATE_FAST_WINDOW)) {
      return json({ error: `推得太快了，一分钟最多 ${RATE_FAST_MAX} 本，歇一下再来` }, 429, NO_STORE);
    }
    if (await isRateLimited(env, 'book_suggestions', ipHash, RATE_SLOW_MAX, RATE_SLOW_WINDOW)) {
      return json({ error: `今天推荐的有点多了（上限 ${RATE_SLOW_MAX} 本），明天再来吧` }, 429, NO_STORE);
    }

    const createdAt = new Date().toISOString();
    const res = await env.DB
      .prepare(
        `INSERT INTO book_suggestions (title, author, note, name, status, created_at, decided_at, imported_at, ip_hash)
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
    if (isMissingTable(err)) return json({ error: NEED_TABLE }, 500, NO_STORE);
    return json({ error: '提交失败：' + err.message }, 500, NO_STORE);
  }
}
