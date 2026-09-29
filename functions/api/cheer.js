/**
 * /api/cheer —— 访客打气加油 / 递咖啡互动接口
 *
 *   GET   /api/cheer                     获取全网访客累计打气总数
 *   POST  /api/cheer  { count: N, hp }   批量累加 N 次打气（前端防抖批量提交）
 *
 * 存储在 D1 的 site_meta 表中（key='cheers_count'），采用 SQLite 原子 UPSERT，
 * 避免并发打气覆盖。
 * 针对恶意机器人有蜜罐 hp 过滤与单次步长限制（1 <= N <= 30）。
 */

import { json, dbMissing, isMissingTable, honeyPotHit } from './_shared.js';

const NO_STORE = { 'cache-control': 'no-store' };
const PUBLIC_CACHE = { 'cache-control': 'public, max-age=5' };

export async function onRequestGet({ env }) {
  if (!env.DB) return dbMissing();

  try {
    const row = await env.DB
      .prepare("SELECT value FROM site_meta WHERE key = 'cheers_count'")
      .first();
    const count = (row && parseInt(row.value, 10)) || 0;
    return json({ ok: true, count }, 200, PUBLIC_CACHE);
  } catch (err) {
    if (isMissingTable(err)) {
      return json({ ok: true, count: 0, needTable: true }, 200, NO_STORE);
    }
    return json({ error: '读取打气总数失败：' + err.message }, 500, NO_STORE);
  }
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();

  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  /* 蜜罐：机器人静默返回假成功 */
  if (honeyPotHit(body) || String((body && body.website) || '').trim()) {
    return json({ ok: true, count: 0 }, 200, NO_STORE);
  }

  let add = parseInt((body && body.count) || '', 10);
  if (!Number.isFinite(add) || add <= 0) add = 1;
  add = Math.min(add, 30); /* 单次批量最多累加 30，防极端恶意刷量 */

  try {
    /* 采用 SQLite 3.24+ 原生 UPSERT 原子增加 */
    await env.DB
      .prepare(
        `INSERT INTO site_meta (key, value) VALUES ('cheers_count', CAST(? AS TEXT))
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`
      )
      .bind(add, add)
      .run();

    const row = await env.DB
      .prepare("SELECT value FROM site_meta WHERE key = 'cheers_count'")
      .first();
    const count = (row && parseInt(row.value, 10)) || 0;

    return json({ ok: true, count }, 200, NO_STORE);
  } catch (err) {
    if (isMissingTable(err)) {
      try {
        /* 表还没建时自动建表并补初始记录 */
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')").run();
        await env.DB.prepare("INSERT INTO site_meta (key, value) VALUES ('cheers_count', CAST(? AS TEXT))").bind(add).run();
        return json({ ok: true, count: add }, 200, NO_STORE);
      } catch (createErr) {
        return json({ ok: true, count: add, needTable: true }, 200, NO_STORE);
      }
    }
    return json({ error: '保存打气数据失败：' + err.message }, 500, NO_STORE);
  }
}
