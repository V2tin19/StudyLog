/**
 * _store.js —— agent_* 系列 doc key 的读-合-写公共件
 *
 * 铁律：agent_* 的所有数据只走这里的服务端合并写。
 * 网页写作台是「整包覆盖」式同步（js/modules/sync.js），谁整包谁负责全量；
 * agent 只掌握增量 —— 绝不能把 agent_* key 暴露给整包同步，否则
 * 网页一个旧包推上来就会把排期/日志/画像全部冲掉（kaoyan 时期踩过的坑）。
 *
 * 单用户场景，合并过程不加锁（D1 串行执行单条语句，够用）；
 * 每个写入点一次合并内完成读改写，别跨请求持有旧数据。
 */

const AGENT_KEYS = ['agent_tasks', 'agent_logs', 'agent_profile', 'agent_outbox', 'agent_chat', 'agent_undo'];

export function isAgentKey(key) {
  return AGENT_KEYS.includes(key);
}

export function nowIso() {
  return new Date().toISOString();
}

/** 与 study-session.js 的 id 同构：时间戳 + 5 位随机 */
export function newId() {
  return Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

/** 读 doc。表不存在/坏 JSON → { data: null, updatedAt: '' } */
export async function readDoc(env, key) {
  try {
    const row = await env.DB.prepare('SELECT payload, updated_at FROM doc WHERE key = ?').bind(key).first();
    if (!row) return { data: null, updatedAt: '' };
    let data = null;
    try { data = JSON.parse(row.payload || 'null'); } catch { data = null; }
    return { data, updatedAt: row.updated_at || '' };
  } catch {
    return { data: null, updatedAt: '' };
  }
}

/** 写 doc（整包 upsert，带建表兜底）。返回 updatedAt。 */
export async function writeDoc(env, key, data) {
  const payload = JSON.stringify(data);
  const now = nowIso();
  try {
    await env.DB.prepare(`
      INSERT INTO doc (key, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).bind(key, payload, now).run();
  } catch (err) {
    try {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS doc (key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')"
      ).run();
      await env.DB.prepare(
        'INSERT OR REPLACE INTO doc (key, payload, updated_at) VALUES (?, ?, ?)'
      ).bind(key, payload, now).run();
    } catch (e2) {
      throw new Error('写入失败：' + (e2.message || err.message));
    }
  }
  return now;
}

/**
 * 读 → mutate → 写。mutate 返回新的完整数据（返回 null/undefined 表示放弃写入）。
 * 返回 { data, updatedAt } 或 { data: null, aborted: true }。
 */
export async function mergeDoc(env, key, current, mutate) {
  const next = mutate(current);
  if (next === null || next === undefined) return { data: current, aborted: true };
  const updatedAt = await writeDoc(env, key, next);
  return { data: next, updatedAt };
}
