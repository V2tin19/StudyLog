/**
 * /api/admin/kaoyan-plan —— 考研计划（doc 表 key='kaoyan' 的专用读写口）
 *
 *   GET /api/admin/kaoyan-plan          读计划（没有就返回一份骨架）
 *   PUT /api/admin/kaoyan-plan          整包写计划（bot / 外部 AI agent 用）
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 *
 * 计划就是一坨版本化 JSON，结构故意宽松 —— 让 LLM 有发挥空间：
 *   {
 *     examDate: "2026-12-26",            考试日期（倒计时用）
 *     template: { "1": [slots...] },     每周模板，键 '0'~'6'（周日~周六）
 *     days:    { "2026-10-31": { slots: [...], note: "" } },  具体某天的安排，优先于模板
 *     ...其他字段随 AI 自由扩展（阶段目标、错题本计划等）
 *   }
 *   slot = { start: "08:30", end: "11:30", subject: "数学", topic: "..." , status: "todo" }
 *
 * 「整包写」是因为计划本身就是整读整用的展示数据；但写入前做结构校验，
 * 把 LLM 可能产出的坏数据（时间倒序、日期格式错、超大 payload）挡在门外。
 */

import { json, dbMissing, requireAdmin, isValidDate } from '../_shared.js';

const NO_STORE = { 'cache-control': 'no-store' };
const DOC_KEY = 'kaoyan';
const MAX_PAYLOAD = 400000;

function defaultPlan() {
  return {
    examDate: '',
    template: {},     /* '0'~'6' -> slots，空模板 = 还没生成过 */
    days: {}          /* 'YYYY-MM-DD' -> { slots, note }，覆盖模板 */
  };
}

/* 时间格式 HH:MM（24 小时制） */
function isTime(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
}

function toMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

/* 校验一个 slot 数组。返回错误消息数组（空 = 通过） */
function validateSlots(slots, where, errs) {
  if (!Array.isArray(slots)) {
    errs.push(`${where}: slots 必须是数组`);
    return;
  }
  const sorted = [];
  slots.forEach((s, i) => {
    const tag = `${where}[${i}]`;
    if (!s || typeof s !== 'object') { errs.push(`${tag}: 不是对象`); return; }
    if (!isTime(s.start)) { errs.push(`${tag}: start("${s.start}") 必须是 HH:MM`); return; }
    if (!isTime(s.end)) { errs.push(`${tag}: end("${s.end}") 必须是 HH:MM`); return; }
    if (toMinutes(s.end) <= toMinutes(s.start)) { errs.push(`${tag}: end 必须晚于 start（不支持跨午夜）`); return; }
    if (!String(s.subject || '').trim()) { errs.push(`${tag}: subject 不能为空`); return; }
    if (String(s.topic || '').length > 500) { errs.push(`${tag}: topic 超过 500 字`); return; }
    sorted.push({ start: s.start, end: s.end });
  });
  /* 时段重叠检查（要求 LLM 输出互斥时段，叠了人没法执行） */
  sorted.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (let i = 1; i < sorted.length; i++) {
    if (toMinutes(sorted[i].start) < toMinutes(sorted[i - 1].end)) {
      errs.push(`${where}: 时段 ${sorted[i].start} 与前一段重叠`);
    }
  }
}

/* 整包校验。返回 {plan} 或 {error} */
function validatePlan(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: '计划必须是一个 JSON 对象' };
  }

  const plan = { ...data };

  if (plan.examDate !== undefined && plan.examDate !== '') {
    if (!isValidDate(String(plan.examDate))) return { error: 'examDate 必须是 YYYY-MM-DD' };
  }

  const errs = [];
  if (plan.template !== undefined) {
    if (typeof plan.template !== 'object' || plan.template === null || Array.isArray(plan.template)) {
      errs.push('template 必须是对象（键 "0"~"6"）');
    } else {
      Object.keys(plan.template).forEach(k => {
        if (!/^[0-6]$/.test(k)) { errs.push(`template 的键 "${k}" 不合法（只允许 "0"~"6"，0 是周日）`); return; }
        validateSlots(plan.template[k], `template.${k}`, errs);
      });
    }
  }

  if (plan.days !== undefined) {
    if (typeof plan.days !== 'object' || plan.days === null || Array.isArray(plan.days)) {
      errs.push('days 必须是对象（键 YYYY-MM-DD）');
    } else {
      const keys = Object.keys(plan.days);
      if (keys.length > 400) errs.push('days 最多 400 天（防止 payload 无限膨胀）');
      keys.forEach(d => {
        if (!isValidDate(d)) { errs.push(`days 的键 "${d}" 不是合法日期`); return; }
        const day = plan.days[d];
        if (!day || typeof day !== 'object' || Array.isArray(day)) { errs.push(`days.${d}: 必须是对象`); return; }
        if (day.slots !== undefined) validateSlots(day.slots, `days.${d}`, errs);
        if (day.note !== undefined && String(day.note).length > 1000) errs.push(`days.${d}.note 超过 1000 字`);
      });
    }
  }

  if (errs.length) return { error: '计划校验未通过：' + errs.slice(0, 5).join('；') + (errs.length > 5 ? ` 等 ${errs.length} 处` : '') };
  return { plan };
}

async function readPlanDoc(env) {
  try {
    const row = await env.DB.prepare('SELECT payload, updated_at FROM doc WHERE key = ?').bind(DOC_KEY).first();
    if (!row) return { plan: null, updatedAt: '' };
    let plan = null;
    try { plan = JSON.parse(row.payload || 'null'); } catch { plan = null; }
    return { plan, updatedAt: row.updated_at || '' };
  } catch {
    return { plan: null, updatedAt: '' };   /* doc 表还没建等情况，当没有计划 */
  }
}

/* ---------------- GET ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const { plan, updatedAt } = await readPlanDoc(env);
  if (!plan) {
    return json({ ok: true, plan: defaultPlan(), updatedAt: '', fresh: true }, 200, NO_STORE);
  }
  return json({ ok: true, plan, updatedAt }, 200, NO_STORE);
}

/* ---------------- PUT ---------------- */
export async function onRequestPut({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE);
  }

  const data = body && body.plan ? body.plan : body;
  const v = validatePlan(data);
  if (v.error) return json({ error: v.error }, 400, NO_STORE);

  const payload = JSON.stringify(v.plan);
  if (payload.length > MAX_PAYLOAD) {
    return json({ error: `计划过大（${payload.length} 字符，上限 ${MAX_PAYLOAD}）` }, 400, NO_STORE);
  }

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

  return json({ ok: true, updatedAt: now }, 200, NO_STORE);
}
