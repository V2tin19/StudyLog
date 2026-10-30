/**
 * /api/admin/study-session —— 学习台账的「服务端合并写」入口
 *
 *   GET    /api/admin/study-session?days=30   最近 N 天的 sessions + 打卡
 *   POST   /api/admin/study-session           新增记录或打卡（服务端合并进 study doc）
 *          body: { session: {...} }  或  { sessions: [{...}, ...] }
 *          body: { checkin: "YYYY-MM-DD" }   补打卡（bot 用）
 *   DELETE /api/admin/study-session?id=xxx    按 id 删一条（bot 的「撤销」用）
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 *
 * 为什么不让 bot 自己整包读写 doc['study']：
 * 网页端是「整包覆盖」式同步（见 js/modules/sync.js），谁整包谁负责全量。
 * bot 只掌握增量，让它整包写会在网页下次推送时被覆盖、或把网页数据冲掉。
 * 所以这里在服务端做「读原包 → 塞进去 → 写回」的原子合并，bot 只报增量。
 */

import { json, dbMissing, requireAdmin, isValidDate } from '../_shared.js';

const NO_STORE = { 'cache-control': 'no-store' };
const DOC_KEY = 'study';

/* 单条记录的字段上限。防的是 bot 拿到 LLM 抽风输出后往库里灌垃圾 */
const MAX_SUBJECT = 60;
const MAX_CONTENT = 2000;
const MAX_DURATION = 1440;      /* 一天也就这么多分钟 */
const MAX_BATCH = 20;           /* 一次最多补录几条 */

const EMPTY_STUDY = () => ({ sessions: [], tasks: [], books: [], skills: [], checkin: {} });

/* 「今天」必须按北京时间算。Workers 跑在 UTC，直接 toISOString 会在
   北京时间 0:00~8:00 之间把「今天」算成昨天 —— 这正是日期错乱的经典来源 */
function shanghaiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function parseStudyDoc(payload) {
  try {
    const data = JSON.parse(payload || 'null');
    if (data && typeof data === 'object') {
      return {
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        books: Array.isArray(data.books) ? data.books : [],
        skills: Array.isArray(data.skills) ? data.skills : [],
        checkin: (data.checkin && typeof data.checkin === 'object') ? data.checkin : {}
      };
    }
  } catch { /* 库里是坏的就从空开始，别让一个坏包把录入通道堵死 */ }
  return EMPTY_STUDY();
}

/* 校验 + 规整一条 session。返回 {session} 或 {error} */
function normalizeSession(raw, todayStr) {
  if (!raw || typeof raw !== 'object') return { error: '记录格式不对' };

  const subject = String(raw.subject || '').trim().slice(0, MAX_SUBJECT);
  const content = String(raw.content || '').trim().slice(0, MAX_CONTENT);
  const date = String(raw.date || todayStr).trim();
  const duration = Math.round(Number(raw.duration));

  if (!subject) return { error: '科目不能为空' };
  if (!duration || duration <= 0) return { error: '学习时长必须是正数（分钟）' };
  if (duration > MAX_DURATION) return { error: `单条时长不能超过 24 小时（${MAX_DURATION} 分钟）` };
  if (!isValidDate(date)) return { error: '日期格式必须是 YYYY-MM-DD' };
  if (date > todayStr) return { error: `不能记录未来的日期（${date} > 今天 ${todayStr}）` };

  /* 与前端 Store.addItem 生成的字段保持同构，网页端才能无缝展示 */
  return {
    session: {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      subject,
      duration,
      content,
      date,
      createdAt: new Date().toISOString(),
      source: 'bot'          /* 标一下来源，网页统计想区分时可用 */
    }
  };
}

/* ---------------- GET：最近 N 天 ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 365);
  const since = new Date(Date.now() + 8 * 3600 * 1000 - days * 86400000).toISOString().slice(0, 10);

  const row = await env.DB.prepare('SELECT payload FROM doc WHERE key = ?').bind(DOC_KEY).first();
  const study = parseStudyDoc(row && row.payload);

  const sessions = study.sessions.filter(s => s && s.date && s.date >= since);
  /* 打卡可能比查询窗口早（streak 要往前数），全量给，反正是个小对象 */
  return json({ ok: true, days, since, sessions, checkin: study.checkin }, 200, NO_STORE);
}

/* ---------------- POST：服务端合并写入 ---------------- */
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

  const rawList = Array.isArray(body?.sessions)
    ? body.sessions
    : (body?.session ? [body.session] : null);

  /* ---- 打卡分支：body 是 { checkin: "YYYY-MM-DD" } ---- */
  if (!rawList && body && body.checkin) {
    const date = String(body.checkin).trim();
    if (!isValidDate(date)) return json({ error: '打卡日期格式必须是 YYYY-MM-DD' }, 400, NO_STORE);
    if (date > shanghaiToday()) return json({ error: '不能给未来打卡' }, 400, NO_STORE);

    const row = await env.DB.prepare('SELECT payload FROM doc WHERE key = ?').bind(DOC_KEY).first().catch(() => null);
    const study = parseStudyDoc(row && row.payload);
    study.checkin[date] = true;

    const now = new Date().toISOString();
    try {
      await env.DB.prepare(`
        INSERT INTO doc (key, payload, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `).bind(DOC_KEY, JSON.stringify(study), now).run();
    } catch (err) {
      try {
        await env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS doc (key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')"
        ).run();
        await env.DB.prepare(
          'INSERT OR REPLACE INTO doc (key, payload, updated_at) VALUES (?, ?, ?)'
        ).bind(DOC_KEY, JSON.stringify(study), now).run();
      } catch (e2) {
        return json({ error: '写入失败：' + (e2.message || err.message) }, 500, NO_STORE);
      }
    }

    return json({ ok: true, checkin: date, updatedAt: now }, 200, NO_STORE);
  }

  if (!rawList) {
    return json({ error: '请求体里需要有 session 或 sessions 数组' }, 400, NO_STORE);
  }
  if (rawList.length === 0 || rawList.length > MAX_BATCH) {
    return json({ error: `一次只能写 1~${MAX_BATCH} 条` }, 400, NO_STORE);
  }

  /* 用北京时间算「今天」，信客户端传的日期就乱了 */
  const todayStr = shanghaiToday();

  const normalized = [];
  for (const raw of rawList) {
    const r = normalizeSession(raw, todayStr);
    if (r.error) return json({ error: r.error }, 400, NO_STORE);
    normalized.push(r.session);
  }

  /* 读原包 → 合并 → 写回，整个过程不加锁（D1 串行执行单条 batch，单用户场景够用） */
  let row = null;
  try {
    row = await env.DB.prepare('SELECT payload FROM doc WHERE key = ?').bind(DOC_KEY).first();
  } catch {
    row = null;   /* doc 表可能还没建，走下面的建表分支 */
  }

  const study = parseStudyDoc(row && row.payload);
  /* 新记录排前面，跟网页端 unshift 的行为一致 */
  study.sessions = normalized.concat(study.sessions);

  const payload = JSON.stringify(study);
  const now = new Date().toISOString();

  try {
    await env.DB.prepare(`
      INSERT INTO doc (key, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).bind(DOC_KEY, payload, now).run();
  } catch (err) {
    try {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS doc (key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')"
      ).run();
      await env.DB.prepare(
        'INSERT OR REPLACE INTO doc (key, payload, updated_at) VALUES (?, ?, ?)'
      ).bind(DOC_KEY, payload, now).run();
    } catch (e2) {
      return json({ error: '写入失败：' + (e2.message || err.message) }, 500, NO_STORE);
    }
  }

  return json({
    ok: true,
    saved: normalized.length,
    sessions: normalized,
    updatedAt: now
  }, 200, NO_STORE);
}

/* ---------------- DELETE：按 id 撤销 ---------------- */
export async function onRequestDelete({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ error: '需要 id 参数' }, 400, NO_STORE);

  const row = await env.DB.prepare('SELECT payload FROM doc WHERE key = ?').bind(DOC_KEY).first();
  if (!row) return json({ error: '还没有任何学习数据' }, 404, NO_STORE);

  const study = parseStudyDoc(row.payload);
  const before = study.sessions.length;
  study.sessions = study.sessions.filter(s => s.id !== id);
  if (study.sessions.length === before) {
    return json({ error: '没找到这条记录（可能已删除）' }, 404, NO_STORE);
  }

  await env.DB.prepare(
    'UPDATE doc SET payload = ?, updated_at = ? WHERE key = ?'
  ).bind(JSON.stringify(study), new Date().toISOString(), DOC_KEY).run();

  return json({ ok: true, deleted: id }, 200, NO_STORE);
}
