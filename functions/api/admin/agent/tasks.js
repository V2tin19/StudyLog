/**
 * /api/admin/agent/tasks —— 弹性任务（FlexibleTask）读写口
 *
 *   GET    /api/admin/agent/tasks            任务列表 + 每个任务的完成进度
 *   POST   /api/admin/agent/tasks            body: { task: {...} } 新建
 *   PUT    /api/admin/agent/tasks            body: { id, ...patch } 改字段
 *   DELETE /api/admin/agent/tasks?id=xxx     删除
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 *
 * 任务模型（doc key: agent_tasks，只走服务端合并写，绝不进 sync.js 整包集）：
 *   { id, name, aliases[], subject, targetMinutes,
 *     cycle: 'daily'|'weekly'|'total', dueDate, priority(1~3), archived, createdAt }
 *
 * 进度统计口径：sessions 里 task_id 匹配优先，科目名匹配兜底
 * （快车道记学习只带科目，进度条按科目归账才走得动）。
 * 窗口：daily=今天，weekly=本周一到现在，total=全部。
 */

import { json, dbMissing, requireAdmin, isValidDate } from '../../_shared.js';
import { readDoc, writeDoc, nowIso } from '../../agent/_store.js';
import { createTask } from '../../agent/_agent.js';
import { shanghaiToday, weekdayPy, dayNum, fromDayNum } from '../../agent/_nlu.js';

const NO_STORE = { 'cache-control': 'no-store' };

function parseTasks(data) {
  const doc = data && typeof data === 'object' ? data : {};
  return Array.isArray(doc.tasks) ? doc.tasks.filter(t => t && typeof t === 'object') : [];
}

function weekStart(dateStr) {
  return fromDayNum(dayNum(dateStr) - weekdayPy(dateStr));   /* 周一 */
}

/** 每个任务按窗口统计已完成分钟 */
function withProgress(tasks, sessions, today) {
  const ws = weekStart(today);
  return tasks.map(t => {
    const matched = sessions.filter(s => {
      if (!s || typeof s !== 'object') return false;
      const byId = s.task_id && s.task_id === t.id;
      const bySubject = !s.task_id && t.subject && s.subject === t.subject;
      if (!byId && !bySubject) return false;
      if (t.cycle === 'daily') return s.date === today;
      if (t.cycle === 'weekly') return s.date >= ws && s.date <= today;
      return true;
    });
    const doneMinutes = matched.reduce((a, s) => a + (s.duration || 0), 0);
    return { ...t, doneMinutes, sessionCount: matched.length };
  });
}

function normalizePatch(patch) {
  const out = {};
  if (patch.name !== undefined) out.name = String(patch.name).slice(0, 60);
  if (patch.aliases !== undefined) {
    out.aliases = Array.isArray(patch.aliases) ? patch.aliases.slice(0, 8).map(a => String(a).slice(0, 30)) : [];
  }
  if (patch.subject !== undefined) out.subject = String(patch.subject).slice(0, 60);
  if (patch.targetMinutes !== undefined) out.targetMinutes = Math.max(1, Math.round(+patch.targetMinutes || 30));
  if (patch.cycle !== undefined) out.cycle = ['daily', 'weekly', 'total'].includes(patch.cycle) ? patch.cycle : 'daily';
  if (patch.dueDate !== undefined) out.dueDate = isValidDate(String(patch.dueDate)) ? String(patch.dueDate) : '';
  if (patch.priority !== undefined) out.priority = Math.min(3, Math.max(1, Math.round(+patch.priority || 2)));
  if (patch.archived !== undefined) out.archived = !!patch.archived;
  return out;
}

/* ---------------- GET ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const { data } = await readDoc(env, 'agent_tasks');
  const tasks = parseTasks(data);
  const today = shanghaiToday();

  const { data: study } = await readDoc(env, 'study');
  const sessions = study && Array.isArray(study.sessions) ? study.sessions : [];

  return json({ ok: true, today, tasks: withProgress(tasks, sessions, today) }, 200, NO_STORE);
}

/* ---------------- POST ---------------- */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  const task = body && body.task;
  if (!task || typeof task !== 'object') return json({ error: '需要有 task 字段' }, 400, NO_STORE);
  if (!String(task.name || '').trim()) return json({ error: '任务名称不能为空' }, 400, NO_STORE);

  const created = await createTask(env, task);
  return json({ ok: true, task: created }, 200, NO_STORE);
}

/* ---------------- PUT ---------------- */
export async function onRequestPut({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  const id = body && body.id;
  if (!id) return json({ error: '需要 id 字段' }, 400, NO_STORE);

  const { data } = await readDoc(env, 'agent_tasks');
  const tasks = parseTasks(data);
  const t = tasks.find(x => x.id === id);
  if (!t) return json({ error: '没找到这个任务' }, 404, NO_STORE);
  Object.assign(t, normalizePatch(body), { updatedAt: nowIso() });
  await writeDoc(env, 'agent_tasks', { tasks });
  return json({ ok: true, task: t }, 200, NO_STORE);
}

/* ---------------- DELETE ---------------- */
export async function onRequestDelete({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ error: '需要 id 参数' }, 400, NO_STORE);

  const { data } = await readDoc(env, 'agent_tasks');
  const tasks = parseTasks(data);
  const next = tasks.filter(t => t.id !== id);
  if (next.length === tasks.length) return json({ error: '没找到这个任务（可能已删除）' }, 404, NO_STORE);
  await writeDoc(env, 'agent_tasks', { tasks: next });
  return json({ ok: true, deleted: id }, 200, NO_STORE);
}
