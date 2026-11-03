/**
 * _agent.js —— 助手大脑：意图路由 + 卡片 + 撤销栈（服务端）
 *
 * 自 kaoyan bot 的 handlers.py 移植，路由口径一致：「关键词优先，LLM 兜底」。
 * 与 bot 版的差异（本次设计决策）：
 * 1. 学习录入走「卡片确认」——快车道/LLM 抽到的记录先进 pending，用户确认才落库；
 *    bot 版是直接落库。这是「录入确认」纪律，猜错零成本。
 * 2. 撤销栈放在服务端 doc（agent_undo），跨会话、跨设备有效；
 *    bot 版是进程内存 deque，重启就没。
 * 3. 会话历史存 doc（agent_chat），网页和 pusher 共用同一条对话流。
 *
 * 铁律不变：所有日期都由 _nlu.resolve_day_token 在代码里解析，
 * LLM 只产出 day 标记。
 */

import { try_parse_log, resolve_day_token, shanghaiToday, shanghaiNowHHMM, weekdayPy } from './_nlu.js';
import {
  WEEKDAY_CN, day_plan, render_day, countdown_text, week_stats, fmt_minutes
} from './_stats.js';
import { readDoc, writeDoc, newId, nowIso } from './_store.js';
import { llmChat, llmChatJson, LLMError } from '../_llm.js';
import { normalizeSession, parseStudyDoc } from '../admin/study-session.js';

/* ---------------------------------------------------------------
 * 意图正则（与 handlers.py 同口径）
 * --------------------------------------------------------------- */

export const FEEDBACK_RE = /状态不好|没状态|不在状态|太累|好累|累了|疲惫|疲|生病|感冒|发烧|头疼|不舒服|不想学|学不进|学不动|效率低|没效率|emo|丧|烦|焦虑|崩了|失眠|熬夜了|有事|太忙|加班|要出门|出门|面试|考试周|心情不好|状态差/;
export const QUERY_RE = /(安排|计划|日程|学什么|学点啥|学啥|该干嘛|干什么|倒计时)/;
export const REGEN_RE = /重排|重新生成|重新安排|重新排|排一下|帮我排|生成.{0,4}计划|更新计划|再来一份计划/;
export const REPORT_RE = /总结|周报|复盘|汇报/;
export const STATS_RE = /(今天|本周|这周|最近).{0,6}(学了|学了多久|学了多少|时长|多久)/;
export const UNDO_RE = /撤销|记错了|删掉刚才|撤回/;
export const CHECKIN_RE = /^打卡$|^打卡了|^补打卡|打个卡/;
export const EXAM_DATE_RE = /(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})/;
export const HELP_RE = /^帮助$|^菜单$|^功能|^help|^你能干|怎么用|^指令/;

export const HELP_TEXT = [
  '📖 我能帮你做这些（直接说人话就行）：',
  '· 记学习：「今天下午学了2小时数据结构，刷了王道课后题」（出卡片，确认才记）',
  '· 查安排：「今天安排」「现在该学什么」「明天计划」',
  '· 查统计：「今天学了多久」「本周学了多少」',
  '· 排期：「今天学数学两小时」（AI 直接排好时间块，可撤销）',
  '· 打卡 / 撤销：「打卡」「撤销刚才那条」',
  '· 设考试日期：「考试日期 2026-12-26」'
].join('\n');

const MAX_UNDO = 10;
const MAX_CHAT_MESSAGES = 100;

/* ---------------------------------------------------------------
 * 上下文读取（一次消息读一批，别零碎打 D1）
 * --------------------------------------------------------------- */

async function loadContext(env) {
  const today = shanghaiToday();
  const hhmm = shanghaiNowHHMM();
  const [{ data: plan }, { data: study }, { data: profile }] = await Promise.all([
    readDoc(env, 'kaoyan'),
    readDoc(env, 'study'),
    readDoc(env, 'agent_profile')
  ]);
  const targetMinutes = profile?.schedule?.weeklyTargetMinutes || 2940;
  const nowDesc = `${today} ${hhmm} ${WEEKDAY_CN[weekdayPy(today)]}`;
  return { today, hhmm, plan: plan || {}, study: study || {}, profile: profile || {}, targetMinutes, nowDesc };
}

function weekdayCn(dateStr) {
  return WEEKDAY_CN[weekdayPy(dateStr)];
}

/* ---------------------------------------------------------------
 * 学习记录落库（与 /api/admin/study-session 同一套规整规则）
 * --------------------------------------------------------------- */

export async function addSessionsToStudy(env, items) {
  const today = shanghaiToday();
  const normalized = [];
  for (const raw of items) {
    const r = normalizeSession({
      subject: raw.subject,
      duration: raw.minutes != null ? raw.minutes : raw.duration,
      content: raw.content,
      date: raw.date,
      task_id: raw.task_id
    }, today);
    if (r.error) throw new Error(r.error);
    r.session.source = 'agent';     /* 来源标记：助手录入 */
    normalized.push(r.session);
  }

  let row = null;
  try {
    row = await env.DB.prepare('SELECT payload FROM doc WHERE key = ?').bind('study').first();
  } catch { row = null; }
  const study = parseStudyDoc(row && row.payload);
  study.sessions = normalized.concat(study.sessions);
  await writeDoc(env, 'study', study);
  return normalized;
}

async function deleteSessionFromStudy(env, sessionId) {
  const row = await env.DB.prepare('SELECT payload FROM doc WHERE key = ?').bind('study').first();
  if (!row) throw new Error('还没有任何学习数据');
  const study = parseStudyDoc(row.payload);
  const before = study.sessions.length;
  study.sessions = study.sessions.filter(s => s.id !== sessionId);
  if (study.sessions.length === before) throw new Error('没找到这条记录（可能已删除）');
  await writeDoc(env, 'study', study);
}

/* ---------------------------------------------------------------
 * 撤销栈（服务端 doc，跨设备有效）
 * --------------------------------------------------------------- */

async function pushUndo(env, entry) {
  const { data } = await readDoc(env, 'agent_undo');
  const list = Array.isArray(data) ? data : [];
  list.push({ id: newId(), ts: nowIso(), ...entry });
  while (list.length > MAX_UNDO) list.shift();
  await writeDoc(env, 'agent_undo', list);
}

export async function readUndoStack(env) {
  const { data } = await readDoc(env, 'agent_undo');
  return Array.isArray(data) ? data : [];
}

/** 撤掉最近一条可撤销操作。返回文案。 */
export async function undoLast(env) {
  const stack = await readUndoStack(env);
  if (!stack.length) return '最近没有可撤销的操作（撤销栈最多留 10 条）。';
  const entry = stack[stack.length - 1];
  try {
    if (entry.kind === 'session') {
      await deleteSessionFromStudy(env, entry.undo.sessionId);
    } else if (entry.kind === 'plan_day') {
      const { data: plan } = await readDoc(env, 'kaoyan');
      const p = plan || {};
      p.days = p.days || {};
      if (entry.undo.slots === null) delete p.days[entry.undo.date];
      else p.days[entry.undo.date] = { slots: entry.undo.slots, note: entry.undo.note || '' };
      await writeDoc(env, 'kaoyan', p);
    } else {
      return '这条操作类型不支持撤销。';
    }
  } catch (e) {
    return `⚠️ 撤销失败：${e.message}`;
  }
  stack.pop();
  await writeDoc(env, 'agent_undo', stack);
  return `↩️ 已撤销：${entry.label}`;
}

/* ---------------------------------------------------------------
 * 卡片（pending 存 agent_chat，确认才执行）
 * --------------------------------------------------------------- */

const CARD_TTL_MS = 2 * 3600 * 1000;

async function loadChatDoc(env) {
  const { data } = await readDoc(env, 'agent_chat');
  const doc = data && typeof data === 'object' ? data : {};
  return {
    messages: Array.isArray(doc.messages) ? doc.messages : [],
    pending: doc.pending && typeof doc.pending === 'object' ? doc.pending : {}
  };
}

function prunePending(pending) {
  const now = Date.now();
  const ids = Object.keys(pending);
  for (const id of ids) {
    if (!pending[id] || now - (pending[id].ts || 0) > CARD_TTL_MS) delete pending[id];
  }
  while (ids.length > 10) delete pending[ids.shift()];
}

async function saveChatDoc(env, doc) {
  prunePending(doc.pending);
  while (doc.messages.length > MAX_CHAT_MESSAGES) doc.messages.shift();
  await writeDoc(env, 'agent_chat', doc);
}

/* ---------------------------------------------------------------
 * 入口：处理一句话
 * 返回 { reply, cards: [{id, type, payload, actions}], state }
 * --------------------------------------------------------------- */

export async function handleAgentMessage(env, rawText, { source = 'web' } = {}) {
  const text = String(rawText || '').trim();
  if (!text) return { reply: '', cards: [] };

  try {
    return await _route(env, text, source);
  } catch (e) {
    if (e instanceof LLMError) {
      return { reply: `⚠️ AI 出了点问题：${e.message}\n可以稍后再试，或先用「帮助」看手动指令。`, cards: [] };
    }
    return { reply: `⚠️ 出错了：${e.message}`, cards: [] };
  }
}

async function _route(env, text, source) {
  const ctx = await loadContext(env);
  const doc = await loadChatDoc(env);

  const finish = async (reply, cards = []) => {
    doc.messages.push({ role: 'user', text, ts: nowIso(), source });
    doc.messages.push({ role: 'agent', text: reply, ts: nowIso(), cards: cards.map(c => ({ id: c.id, type: c.type })) });
    await saveChatDoc(env, doc);
    return { reply, cards };
  };

  /* ---- 1. 帮助 ---- */
  if (HELP_RE.test(text)) return finish(HELP_TEXT);

  /* ---- 2. 撤销 ---- */
  if (UNDO_RE.test(text)) return finish(await undoLast(env));

  /* ---- 3. 打卡 ---- */
  if (CHECKIN_RE.test(text)) return finish(await _checkin(env, ctx));

  /* ---- 4. 设置/查考试日期 ---- */
  if (text.includes('考试') && (text.includes('日期') || text.includes('时间') || text.includes('倒计时'))) {
    return finish(await _examDate(env, ctx, text));
  }

  /* ---- 5. 重排本周（M2） ---- */
  if (REGEN_RE.test(text) || (text.includes('计划') && text.includes('生成'))) {
    return finish(await _regenWeek(env, ctx, text));
  }

  /* ---- 6. 状态反馈 → 重排当天/明天（M2） ---- */
  if (FEEDBACK_RE.test(text)) {
    return finish(await _adjustDay(env, ctx, text));
  }

  /* ---- 7. 排期请求：「今天学数学两小时」（M2） ---- */
  const scheduleReq = _matchScheduleRequest(text);
  if (scheduleReq) {
    return finish(await _scheduleFromRequest(env, ctx, text, scheduleReq));
  }

  /* ---- 8. 学习记录：正则快车道 ----
     放在模糊意图（统计/查计划）之前 —— bot 旧版把 STATS_RE 排在前面，
     「今天下午学了2小时数据结构」会被「今天+下午+学了」截走当统计查询。
     快车道精度高（必须有时长 + 科目/学习动词），先试它不会误伤。 */
  const parsed = try_parse_log(text, ctx.today);
  if (parsed) {
    const draft = await _draftLogCard(env, ctx, doc, [parsed]);
    return finish(draft.reply, draft.cards);
  }

  /* ---- 9. 查统计 ---- */
  if (STATS_RE.test(text)) return finish(await _stats(env, ctx, text));

  /* ---- 10. 周报（M3） ---- */
  if (REPORT_RE.test(text)) return finish(await _weeklyReport(env, ctx));

  /* ---- 11. 查计划 ---- */
  if (QUERY_RE.test(text)) return finish(await _queryPlan(env, ctx, text));

  /* ---- 12. 学习记录：LLM 兜底（确实像在说学习才问 LLM，省 token） ---- */
  if (/学|背|刷|练|复习|做.{0,4}题|错题|笔记|网课/.test(text)) {
    const sessions = await llmExtractSessions(env, text, ctx.nowDesc);
    if (sessions.length) {
      const draft = await _draftLogCard(env, ctx, doc, sessions);
      return finish(draft.reply, draft.cards);
    }
  }

  /* ---- 13. 闲聊兜底 ---- */
  const cd = countdown_text(ctx.plan, ctx.today);
  const reply = await llmChat(env, [
    { role: 'system', content: chatReplySystem(cd ? cd : '未设置考试日期') },
    { role: 'user', content: text }
  ], { maxTokens: 300, temperature: 0.7 });
  return finish(reply);
}

/* ================= 学习记录（卡片确认） ================= */

async function _draftLogCard(env, ctx, doc, items) {
  const sessions = [];
  for (const it of items) {
    const r = resolve_day_token(it.day_token, ctx.today);
    if (r.date === null) return `⚠️ 日期没解析对：${r.note}，这条先没记。`;
    if (r.date > ctx.today) return `⚠️「${r.note}」是未来的日期，学习记录不能记未来哦。`;
    sessions.push({
      subject: String(it.subject || '其他').slice(0, 60),
      minutes: it.minutes,
      content: String(it.content || '').slice(0, 200),
      date: r.date,
      dateLabel: r.date === ctx.today ? '今天' : (r.date === _yesterday(ctx.today) ? '昨天' : r.date.slice(5) + ' ' + weekdayCn(r.date))
    });
  }

  const id = 'c_' + newId();
  doc.pending[id] = { type: 'log_confirm', payload: { sessions }, ts: Date.now() };
  await saveChatDoc(env, doc);

  const lines = sessions.map(s =>
    `· ${s.dateLabel} · ${s.subject} · ${fmt_minutes(s.minutes)}${s.content ? `（${s.content}）` : ''}`);
  const card = {
    id,
    type: 'log_confirm',
    title: '记下这些学习？',
    payload: { sessions },
    actions: ['confirm', 'cancel'],
    confirmText: '确认记录',
    cancelText: '算了'
  };
  return {
    reply: `帮你整理成 ${sessions.length} 条记录，确认后就写进台账：\n${lines.join('\n')}`,
    cards: [card]
  };
}

function _yesterday(today) {
  const n = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) / 86400000 - 1;
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/** 用户点了卡片「确认」。override 可带网页端改过的 sessions。返回文案。 */
export async function confirmCard(env, cardId, override = null) {
  const doc = await loadChatDoc(env);
  const card = doc.pending[cardId];
  if (!card) return { reply: '这张卡片已过期或已处理过。', cards: [] };
  delete doc.pending[cardId];

  if (card.type === 'log_confirm') {
    const sessions = (override && Array.isArray(override.sessions) && override.sessions.length)
      ? override.sessions : card.payload.sessions;
    const saved = await addSessionsToStudy(env, sessions);
    for (const s of saved) {
      await pushUndo(env, {
        kind: 'session',
        label: `${s.date} ${s.subject} ${fmt_minutes(s.duration || 0)}`,
        undo: { sessionId: s.id }
      });
    }
    const lines = saved.map(s => {
      const labelCn = s.date === shanghaiToday() ? '今天'
        : (s.date === _yesterday(shanghaiToday()) ? '昨天' : s.date.slice(5) + ' ' + weekdayCn(s.date));
      let line = `✅ ${labelCn} · ${s.subject} · ${fmt_minutes(s.duration)}`;
      if (s.content) line += `\n   └ ${s.content}`;
      return line;
    });
    const total = saved.reduce((a, s) => a + (s.duration || 0), 0);
    let reply = lines.join('\n') + `\n共 ${saved.length} 条，合计 ${fmt_minutes(total)}`;
    doc.messages.push({ role: 'agent', text: reply, ts: nowIso(), cards: [] });
    await saveChatDoc(env, doc);
    return { reply, cards: [] };
  }

  await saveChatDoc(env, doc);
  return { reply: '这张卡片类型不认识，先忽略了。', cards: [] };
}

/** 用户点了「算了」 */
export async function cancelCard(env, cardId) {
  const doc = await loadChatDoc(env);
  const existed = !!doc.pending[cardId];
  delete doc.pending[cardId];
  await saveChatDoc(env, doc);
  return { reply: existed ? '好的，没记。' : '这张卡片已过期或已处理过。', cards: [] };
}

/* ================= 打卡 / 统计 ================= */

async function _checkin(env, ctx) {
  const { data: study } = await readDoc(env, 'study');
  const s = study && typeof study === 'object' ? study : {};
  s.checkin = s.checkin && typeof s.checkin === 'object' ? s.checkin : {};
  s.checkin[ctx.today] = true;
  await writeDoc(env, 'study', s);

  const dates = Object.keys(s.checkin).filter(d => s.checkin[d]).sort().reverse();
  let streak = 0;
  let cur = ctx.today;
  while (dates.includes(cur)) {
    streak++;
    cur = _yesterday(cur);
  }
  return `✅ 已打卡（${ctx.today}），连续 ${streak} 天 🔥`;
}

async function _stats(env, ctx, text) {
  const sessions = Array.isArray(ctx.study.sessions) ? ctx.study.sessions : [];
  const stats = week_stats(sessions, ctx.study.checkin || {}, ctx.plan, ctx.today, ctx.targetMinutes);
  if (text.includes('今天')) {
    const m = stats.by_day[ctx.today] || 0;
    const checked = (ctx.study.checkin || {})[ctx.today];
    return `今天学了 ${fmt_minutes(m)}` + (checked ? '，已打卡 ✅' : '，还没打卡（发「打卡」）');
  }
  const lines = [`📊 最近 7 天（${stats.start} ~ ${stats.end}）`,
    `总计 ${fmt_minutes(stats.total_minutes)}，日均 ${fmt_minutes(stats.daily_avg_minutes)}`,
    `学习 ${stats.active_days}/7 天，连续 ${stats.streak} 天`];
  const subjects = Object.entries(stats.by_subject).slice(0, 6);
  if (subjects.length) {
    lines.push('科目分布：' + subjects.map(([k, v]) => `${k} ${fmt_minutes(v)}`).join('，'));
  }
  return lines.join('\n');
}

/* ================= 查计划 ================= */

async function _queryPlan(env, ctx, text) {
  let target = ctx.today;
  if (/明天/.test(text)) target = _tomorrow(ctx.today);
  else if (/后天/.test(text)) target = _tomorrow(_tomorrow(ctx.today));
  else if (/昨天/.test(text)) target = _yesterday(ctx.today);

  const { slots, note } = day_plan(ctx.plan, target);
  const body = render_day(target, slots, note, target === ctx.today ? ctx.hhmm : null);
  const cd = countdown_text(ctx.plan, ctx.today);
  return (cd ? cd + '\n\n' : '') + body;
}

function _tomorrow(today) {
  const n = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) / 86400000 + 1;
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/* ================= 考试日期 ================= */

async function _examDate(env, ctx, text) {
  const m = EXAM_DATE_RE.exec(text);
  if (!m) {
    const cd = countdown_text(ctx.plan, ctx.today);
    return cd || '还没设置考试日期。发「考试日期 2026-12-26」来设置。';
  }
  const y = +m[1], mo = +m[2], d = +m[3];
  const n = Date.UTC(y, mo - 1, d) / 86400000;
  const back = new Date(n * 86400000);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return '⚠️ 这个日期不存在，检查一下。';
  }
  const iso = back.toISOString().slice(0, 10);
  const plan = { ...(ctx.plan || {}) };
  plan.examDate = iso;
  await writeDoc(env, 'kaoyan', plan);
  const diff = Math.round(n - Date.UTC(+ctx.today.slice(0, 4), +ctx.today.slice(5, 7) - 1, +ctx.today.slice(8, 10)) / 86400000);
  if (diff < 0) return `已设置考试日期 ${iso}，不过它已经过了……要更新目标吗？`;
  return `✅ 考试日期已设为 ${iso}，距离初试还有 ${diff} 天。发「重排本周计划」按倒计时重新规划。`;
}

/* ================= LLM 任务（提示词自 llm.py 移植） ================= */

const TODAY_TOKEN_RULE = 'day 字段的取值只能是以下标记之一，禁止输出别的："today"（今天）、"yesterday"（昨天）、"before_yesterday"（前天）、"monday"~"sunday"（最近一个过去的该星期几）、"YYYY-MM-DD"（明确的过去某天）、null（没提日期，默认今天）。禁止把"今天"翻译成具体日期，具体日期由系统负责。';

async function llmExtractSessions(env, text, nowDesc) {
  const system = '你是考研学习记录助手。从用户消息里抽取学习记录，输出严格 JSON：\n'
    + '{"sessions":[{"subject":"规范科目名","minutes":整数分钟,'
    + '"content":"学了什么（≤100字，可为空字符串）","day":<day标记>}]}\n'
    + '规范科目名尽量用：数学/英语/政治/数据结构/操作系统/计算机组成原理/计算机网络/其他。\n'
    + '同义词要归一（高数→数学，单词→英语，计网→计算机网络）。\n'
    + '一条消息里有多段学习就输出多条。\n'
    + 'minutes 按文本换算（一个半小时=90，半小时=30）。\n'
    + `现在的准确时间是：${nowDesc}。\n` + TODAY_TOKEN_RULE + '\n'
    + '用户消息里如果根本不是学习相关内容，输出 {"sessions":[]}。\n'
    + '只输出 JSON。';
  const data = await llmChatJson(env, system, text, { maxTokens: 800 });
  const sessions = data?.sessions;
  if (!Array.isArray(sessions)) throw new LLMError('LLM 抽取结果里没有 sessions 数组');
  const out = [];
  for (const s of sessions.slice(0, 10)) {
    if (!s || typeof s !== 'object') continue;
    const subject = String(s.subject || '').trim();
    const minutes = s.minutes;
    if (!subject || typeof minutes !== 'number' || !(minutes > 0)) continue;
    out.push({
      subject: subject.slice(0, 60),
      minutes: Math.round(minutes),
      content: String(s.content || '').trim().slice(0, 200),
      day_token: s.day
    });
  }
  return out;
}

function chatReplySystem(context) {
  return '你是考研备考助手。用户发了一句你没专门功能的话，简短友好地回应（≤80字）。\n'
    + '你可以：记录学习（"今天学了2小时数学"）、查安排（"今天安排"）、'
    + '排时间块（"今天学数学两小时"）、按状态调整（"今天状态不好"）、'
    + '生成周计划（"重排本周"）、周总结（"本周总结"）、打卡（"打卡"）。\n'
    + '回应里可以顺带提示最相关的功能。不要编造学习数据。\n'
    + `用户近况：${context}`;
}

/* ================= M2/M3 占位（下一个里程碑填充） ================= */

async function _regenWeek(env, ctx, text) {
  return '🛠 「重排本周计划」还在装修中，马上就来。';
}

async function _adjustDay(env, ctx, text) {
  return '🛠 按状态调整还在装修中，马上就来。先说一句「今天学了多久」看看数据。';
}

function _matchScheduleRequest(text) {
  return null;   /* M2 实现：解析「今天学数学两小时」类请求 */
}

async function _scheduleFromRequest(env, ctx, text, req) {
  return '🛠 自动排期还在装修中，马上就来。';
}

async function _weeklyReport(env, ctx) {
  return '🛠 周报还在装修中，马上就来。';
}
