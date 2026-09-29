/**
 * /api/comments —— 留言
 *
 *   GET  ?counts=1                          每篇日记的留言数（公开页列表一次查完）
 *   GET  ?scope=diary&target=YYYY-MM-DD     某一篇日记的留言
 *   GET  ?scope=board&limit=&offset=        留言簿分页
 *   POST { scope, target, name, content, hp }  发一条
 *
 * ⚠️ 这是全站唯一一个「不需要令牌的写接口」。
 * 之前整站的安全模型是「访客只读」，靠两层保证：服务端没有给访客用的写接口 +
 * 前端不渲染编辑入口。这个口子一开，那两层都不成立了，所以防护全写在这里：
 *
 *   1. 蜜罐字段 hp        —— 正常访客看不见那个框，机器人会填，填了就假裝成功、不写库
 *   2. 同 IP 限流         —— 默认 1 分钟最多 3 条
 *   3. 内容长度 + 链接过滤 —— 垃圾留言几乎都带链接，这条命中率极高
 *   4. 拉黑名单           —— 站主在写作台拉黑之后直接拒
 *
 * IP 不存原文，只存加盐 SHA-256（ip_hash），只用于限流和拉黑。
 * 盐走环境变量 COMMENT_SALT，没设也能跑（有兜底），但设了才真正防「枚举 IPv4 反查」。
 */

import {
  json, dbMissing, isValidDate,
  isMissingTable, isMissingColumn, parseLocation, hashIp, clientIp, honeyPotHit, hasLink, isBlocked, isRateLimited
} from './_shared.js';

const MAX_NAME = 24;
const MAX_CONTENT = 500;
const DIARY_LIMIT = 50;          /* 日记下面一屏放这么多够了 */
const BOARD_DEFAULT = 15;
const BOARD_MAX = 100;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 3;

const NO_STORE = { 'cache-control': 'no-store' };

/* 表还没建的时候 D1 报 "no such table: comments"。
   这种情况要给一句人能照着做的提示，别把 SQL 原话甩给访客看。 */
const NEED_TABLE = '留言表还没建。可以在写作台的「留言」页上直接复制建表 SQL，去 D1 控制台跑一次。';

/** 数据库行 → 前端认识的留言对象（绝不带 ip_hash 出去） */
function toComment(row) {
  return {
    id: row.id,
    scope: row.scope,
    target: row.target || '',
    name: row.name || '',
    content: row.content || '',
    createdAt: row.created_at || '',
    reply: row.reply || '',
    replyAt: row.reply_at || ''
  };
}

/* ---------------- GET：读留言 ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();

  const url = new URL(request.url);

  /* ---- 每篇日记的留言数：公开页要显示「3 条留言」，
          30 篇日记不能发 30 个请求，所以一次 GROUP BY 查完 ---- */
  if (url.searchParams.get('counts') === '1') {
    try {
      const { results } = await env.DB
        .prepare("SELECT target, COUNT(*) AS n FROM comments WHERE scope = 'diary' AND hidden = 0 GROUP BY target")
        .all();

      const counts = {};
      (results || []).forEach(r => { if (r.target) counts[r.target] = r.n; });
      return json({ ok: true, counts }, 200, NO_STORE);
    } catch (err) {
      /* 表没建时不要报错 —— 日记本身是好的，公开页不显示留言区就行了。
         这里返回 200 + 空计数，让前端无感降级。 */
      if (isMissingTable(err)) return json({ ok: true, counts: {}, needTable: true }, 200, NO_STORE);
      return json({ error: '读取留言数失败：' + err.message }, 500, NO_STORE);
    }
  }

  const scope = url.searchParams.get('scope') === 'board' ? 'board' : 'diary';
  const target = (url.searchParams.get('target') || '').trim();

  if (scope === 'diary' && !isValidDate(target)) {
    return json({ error: 'target 需要是 YYYY-MM-DD 这样的日期' }, 400, NO_STORE);
  }

  let limit = parseInt(url.searchParams.get('limit') || '', 10);
  const max = scope === 'board' ? BOARD_MAX : DIARY_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = scope === 'board' ? BOARD_DEFAULT : DIARY_LIMIT;
  limit = Math.min(limit, max);

  let offset = parseInt(url.searchParams.get('offset') || '', 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  /* 日记下的留言按时间正序（像对话，看完别人说什么再写）；
     留言簿倒序（新的在最上面，一打开就看到最新的）。 */
  const order = scope === 'board' ? 'DESC' : 'ASC';

  try {
    let total = 0;
    const countRow = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE scope = ? AND target = ? AND hidden = 0")
      .bind(scope, target)
      .first();
    if (countRow && typeof countRow.n === 'number') total = countRow.n;

    /* 多取一条来判断「还有没有更早的」，兼容老调用方 */
    let results;
    try {
      const q = await env.DB
        .prepare(
          `SELECT id, scope, target, name, content, created_at, reply, reply_at FROM comments
           WHERE scope = ? AND target = ? AND hidden = 0
           ORDER BY id ${order} LIMIT ? OFFSET ?`
        )
        .bind(scope, target, limit + 1, offset)
        .all();
      results = q.results;
    } catch (colErr) {
      if (isMissingColumn(colErr)) {
        /* 老表还没跑 ALTER TABLE 加 reply 列，降级查询保证不挂 */
        const q = await env.DB
          .prepare(
            `SELECT id, scope, target, name, content, created_at FROM comments
             WHERE scope = ? AND target = ? AND hidden = 0
             ORDER BY id ${order} LIMIT ? OFFSET ?`
          )
          .bind(scope, target, limit + 1, offset)
          .all();
        results = q.results;
      } else {
        throw colErr;
      }
    }

    const rows = results || [];
    const hasMore = rows.length > limit;

    return json({ ok: true, comments: rows.slice(0, limit).map(toComment), hasMore, total }, 200, NO_STORE);
  } catch (err) {
    if (isMissingTable(err)) return json({ ok: true, comments: [], hasMore: false, total: 0, needTable: true }, 200, NO_STORE);
    return json({ error: '读取留言失败：' + err.message }, 500, NO_STORE);
  }
}

/* ---------------- POST：发留言 ---------------- */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE);
  }

  /* ---- 1. 蜜罐 ----
     正常访客看不见这个输入框，只有傻瓜机器人才会老实填。
     故意返回「成功」而不是报错：让机器人以为发进去了，别给它反馈去调参。 */
  if (honeyPotHit(body)) {
    return json({ ok: true, comment: null }, 200, NO_STORE);
  }

  const scope = body && body.scope === 'board' ? 'board' : 'diary';
  const target = String((body && body.target) || '').trim();
  if (scope === 'diary' && !isValidDate(target)) {
    return json({ error: '缺少有效的日记日期' }, 400, NO_STORE);
  }

  /* ---- 2. 内容校验 ---- */
  const name = String((body && body.name) || '').trim().slice(0, MAX_NAME);
  const content = String((body && body.content) || '').trim();

  if (!content) return json({ error: '还没写内容' }, 400, NO_STORE);
  if (content.length > MAX_CONTENT) {
    return json({ error: `内容太长了，上限 ${MAX_CONTENT} 字` }, 400, NO_STORE);
  }
  /* 垃圾留言几乎 100% 带链接。这条会误伤「想分享个链接」的正常人，
     但公开站宁可让人多一句话说明，也别开个口子等着被灌。 */
  if (hasLink(content)) {
    return json({ error: '留言里不能带链接' }, 400, NO_STORE);
  }

  const ipHash = await hashIp(clientIp(request), env.COMMENT_SALT);

  try {
    /* ---- 3. 拉黑名单 ---- */
    if (await isBlocked(env, ipHash)) {
      return json({ error: '这个网络地址已被站主拉黑' }, 403, NO_STORE);
    }

    /* ---- 4. 限流 ---- */
    if (await isRateLimited(env, 'comments', ipHash, RATE_MAX, RATE_WINDOW_MS)) {
      return json({ error: `发得太快了，一分钟最多 ${RATE_MAX} 条，歇一下再来` }, 429, NO_STORE);
    }

    const createdAt = new Date().toISOString();
    const location = parseLocation(request);

    let res;
    try {
      res = await env.DB
        .prepare(
          `INSERT INTO comments (scope, target, name, content, created_at, ip_hash, hidden, reply, reply_at, location)
           VALUES (?, ?, ?, ?, ?, ?, 0, '', '', ?)`
        )
        .bind(scope, target, name, content, createdAt, ipHash, location)
        .run();
    } catch (colErr) {
      if (isMissingColumn(colErr)) {
        res = await env.DB
          .prepare(
            `INSERT INTO comments (scope, target, name, content, created_at, ip_hash, hidden)
             VALUES (?, ?, ?, ?, ?, ?, 0)`
          )
          .bind(scope, target, name, content, createdAt, ipHash)
          .run();
      } else {
        throw colErr;
      }
    }

    return json(
      {
        ok: true,
        comment: {
          id: (res.meta && res.meta.last_row_id) || 0,
          scope,
          target,
          name,
          content,
          createdAt,
          reply: '',
          replyAt: ''
        }
      },
      200,
      NO_STORE
    );
  } catch (err) {
    if (isMissingTable(err)) return json({ error: NEED_TABLE }, 500, NO_STORE);
    return json({ error: '写入失败：' + err.message }, 500, NO_STORE);
  }
}
