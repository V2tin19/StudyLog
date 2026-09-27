/**
 * /api/admin/diary —— 管理接口，只有持有正确令牌的人能用
 *
 *   GET    /api/admin/diary              验证令牌，并返回云端全部日记（含草稿）
 *   POST   /api/admin/diary              写入 / 更新
 *          body: { entry: {...} }        写入单篇
 *          body: { entries: [...] }      批量写入（一键发布用）
 *   DELETE /api/admin/diary?date=Y-M-D   删除某一天
 *
 * 令牌来源：环境变量 ADMIN_TOKEN（在 Cloudflare Pages 设置里配置）
 * 请求头：Authorization: Bearer <令牌>
 *
 * 注意：这里才是真正的关卡。前端隐藏按钮只是 UI 效果，不能当权限用。
 */

import { toEntry, json, dbMissing, safeEqual, isValidDate } from '../_shared.js';

const MAX_BATCH = 500;        // 一次最多几条
const CHUNK = 30;             // 每个 batch 语句包几条，避免单次 SQL 过大
const MAX_CONTENT = 200000;   // 单篇正文最大字符数

/** 校验令牌，返回 null 表示通过，否则返回错误响应 */
function deny(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return json(
      { error: '服务端还没有设置 ADMIN_TOKEN 环境变量，请在 Pages 项目设置里添加后再试' },
      500,
      { 'cache-control': 'no-store' }
    );
  }
  const header = request.headers.get('Authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided || !safeEqual(provided, expected)) {
    return json({ error: '令牌不正确，无权操作' }, 401, { 'cache-control': 'no-store' });
  }
  return null;
}

const NO_STORE = { 'cache-control': 'no-store' };

/* ---------------- GET：验证令牌 + 拉取云端数据 ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = deny(request, env);
  if (rejected) return rejected;

  const { results } = await env.DB
    .prepare('SELECT * FROM diary ORDER BY date DESC')
    .all();

  return json({ ok: true, entries: (results || []).map(toEntry), count: (results || []).length }, 200, NO_STORE);
}

/* ---------------- POST：写入 / 更新 ---------------- */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = deny(request, env);
  if (rejected) return rejected;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE);
  }

  /* 单篇和批量都收，统一成数组 */
  const list = Array.isArray(body?.entries)
    ? body.entries
    : body?.entry
      ? [body.entry]
      : null;

  if (!list) {
    return json({ error: '请求体里需要有 entry（单篇）或 entries（批量）' }, 400, NO_STORE);
  }
  if (list.length === 0) {
    return json({ ok: true, saved: 0, skipped: [], note: '没有可写入的内容' }, 200, NO_STORE);
  }
  if (list.length > MAX_BATCH) {
    return json({ error: `一次最多写入 ${MAX_BATCH} 篇，当前 ${list.length} 篇` }, 400, NO_STORE);
  }

  const now = new Date().toISOString();
  const skipped = [];
  const statements = [];
  let strippedImages = 0;
  let saved = 0;

  for (const raw of list) {
    const date = String(raw?.date || '').trim();

    if (!isValidDate(date)) {
      skipped.push({ date: String(raw?.date ?? ''), reason: '日期不合法，应为 YYYY-MM-DD' });
      continue;
    }

    const content = String(raw?.content || '');
    if (content.length > MAX_CONTENT) {
      skipped.push({ date, reason: `正文过长（${content.length} 字，上限 ${MAX_CONTENT}）` });
      continue;
    }

    /* 只保留 http(s) 图片地址。现阶段本地图片是 base64，同步不了，
       等接上 R2 变成真实网址后会自动开始同步。 */
    const rawImages = Array.isArray(raw?.images) ? raw.images : [];
    const images = rawImages.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));
    strippedImages += rawImages.length - images.length;

    statements.push(
      env.DB.prepare(`
        INSERT INTO diary (date, content, mood, review, images, pinned, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          content    = excluded.content,
          mood       = excluded.mood,
          review     = excluded.review,
          images     = excluded.images,
          pinned     = excluded.pinned,
          updated_at = excluded.updated_at
      `).bind(
        date,
        content,
        String(raw?.mood || ''),
        String(raw?.review || ''),
        JSON.stringify(images),
        raw?.pinned ? 1 : 0,
        String(raw?.createdAt || now),
        now
      )
    );
    saved++;
  }

  try {
    for (let i = 0; i < statements.length; i += CHUNK) {
      await env.DB.batch(statements.slice(i, i + CHUNK));
    }
  } catch (err) {
    return json({ error: '写入失败：' + err.message }, 500, NO_STORE);
  }

  const result = { ok: true, saved, skipped, strippedImages };
  if (strippedImages > 0) {
    result.note = `有 ${strippedImages} 张本地图片未同步（图片同步要等接入 R2 存储后支持）`;
  }
  return json(result, 200, NO_STORE);
}

/* ---------------- DELETE：删除某一天 ---------------- */
export async function onRequestDelete({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = deny(request, env);
  if (rejected) return rejected;

  const date = (new URL(request.url).searchParams.get('date') || '').trim();
  if (!isValidDate(date)) {
    return json({ error: '需要在地址里带上 ?date=YYYY-MM-DD' }, 400, NO_STORE);
  }

  try {
    const res = await env.DB.prepare('DELETE FROM diary WHERE date = ?').bind(date).run();
    return json({ ok: true, deleted: res.meta?.changes ?? 0 }, 200, NO_STORE);
  } catch (err) {
    return json({ error: '删除失败：' + err.message }, 500, NO_STORE);
  }
}
