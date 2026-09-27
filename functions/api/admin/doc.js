/**
 * /api/admin/doc —— 写入「展示型」数据（学习 / 日程 / 目标）
 *
 *   GET  /api/admin/doc           返回全部（no-store，供写作台启动时对账）
 *   POST /api/admin/doc           写入
 *          body: { key, data }            写一类
 *          body: { docs: [{key, data}] }  批量写
 *
 * 令牌来源：环境变量 ADMIN_TOKEN，请求头 Authorization: Bearer <令牌>
 *
 * 为什么用「一个 key 一坨 JSON」而不是给每类数据建一张表：
 * 这些都是单人维护、整体读写的展示数据，拆表会让接口和同步逻辑复杂好几倍，
 * 收益却接近于零。等哪天需要「只查某本书」这类查询再拆也不迟。
 */

import { json, dbMissing, safeEqual } from '../_shared.js';

/* 允许的 key，写别的会被拒 —— 防止前端笔误在库里攒垃圾 */
const VALID_KEYS = ['study', 'schedule', 'goals'];
const MAX_PAYLOAD = 800000;   /* 字符数上限，防呆；正常个人数据也就几十 KB */

const NO_STORE = { 'cache-control': 'no-store' };

function deny(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return json(
      { error: '服务端还没有设置 ADMIN_TOKEN 环境变量，请在 Pages 项目设置里添加后再试' },
      500,
      NO_STORE
    );
  }
  const header = request.headers.get('Authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided || !safeEqual(provided, expected)) {
    return json({ error: '令牌不正确，无权操作' }, 401, NO_STORE);
  }
  return null;
}

/* ---------------- GET：对账用 ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = deny(request, env);
  if (rejected) return rejected;

  let results = [];
  try {
    const r = await env.DB.prepare('SELECT key, payload, updated_at FROM doc').all();
    results = r.results || [];
  } catch (err) {
    return json({ error: '读取失败：' + err.message }, 500, NO_STORE);
  }

  const docs = {};
  results.forEach(row => {
    let data = null;
    try { data = JSON.parse(row.payload || 'null'); } catch { data = null; }
    if (data !== null) docs[row.key] = { data, updatedAt: row.updated_at || '' };
  });

  return json({ ok: true, docs, count: Object.keys(docs).length }, 200, NO_STORE);
}

/* ---------------- POST：写入 ---------------- */
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

  const list = Array.isArray(body?.docs)
    ? body.docs
    : (body && body.key) ? [{ key: body.key, data: body.data }] : null;

  if (!list) {
    return json({ error: '请求体里需要有 key + data，或者 docs 数组' }, 400, NO_STORE);
  }
  if (list.length === 0) {
    return json({ ok: true, saved: 0, updatedAt: new Date().toISOString() }, 200, NO_STORE);
  }

  const now = new Date().toISOString();
  const skipped = [];
  const statements = [];

  for (const item of list) {
    const key = String(item?.key || '').trim();

    if (VALID_KEYS.indexOf(key) === -1) {
      skipped.push({ key, reason: '不认识的 key，只允许 ' + VALID_KEYS.join(' / ') });
      continue;
    }

    const payload = JSON.stringify(item?.data === undefined ? null : item.data);
    if (payload.length > MAX_PAYLOAD) {
      skipped.push({ key, reason: `数据过大（${payload.length} 字符，上限 ${MAX_PAYLOAD}）` });
      continue;
    }

    statements.push(
      env.DB.prepare(`
        INSERT INTO doc (key, payload, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          payload    = excluded.payload,
          updated_at = excluded.updated_at
      `).bind(key, payload, now)
    );
  }

  try {
    if (statements.length) await env.DB.batch(statements);
  } catch (err) {
    return json({ error: '写入失败：' + err.message }, 500, NO_STORE);
  }

  const saved = statements.length;
  const result = { ok: true, saved, skipped, updatedAt: now };
  if (skipped.length) result.note = `有 ${skipped.length} 项被跳过`;
  return json(result, 200, NO_STORE);
}
