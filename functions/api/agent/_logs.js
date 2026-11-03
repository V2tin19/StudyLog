/**
 * _logs.js —— 量化日志的构建核心
 *
 * 用户的路径：给最短的一句原话（「数学卡壳了，有点累」）→
 * AI 结合当天计划表 + 已记录的学习条目，补成一篇完整日志；
 * 量化指标（计划 vs 实际、覆盖科目、连续天数…）全部代码计算，LLM 只负责把话写成人话。
 *
 * 存 doc key: agent_logs —— { logs: { 'YYYY-MM-DD': { raw, ai, metrics, createdAt } } }
 * 只走服务端合并写，绝不进 sync.js 整包集。
 */

import { readDoc, writeDoc, nowIso } from './_store.js';
import { day_plan, planned_minutes, fmt_minutes } from './_stats.js';
import { shanghaiToday, shanghaiNowHHMM, addDays } from './_nlu.js';
import { llmChat } from '../_llm.js';

/** 心态词表（与 health_score 同一套，解析原话里的心情） */
const MOOD_POS = ['好', '棒', '开心', '不错', '很好', '充实', '满', '爽', '顺利'];
const MOOD_MID = ['一般', '还行', '普通', '平平'];
const MOOD_NEG = ['累', '烦', '焦虑', '崩', '丧', '难', '卡', '糟', '差', 'emo', '失眠', '感冒', '头疼', '不舒服', '没状态', '不想学'];

export function parseMood(raw) {
  const s = String(raw || '');
  if (MOOD_POS.some(w => s.includes(w))) return '好';
  if (MOOD_MID.some(w => s.includes(w))) return '一般';
  if (MOOD_NEG.some(w => s.includes(w))) return '糟';
  return '';
}

/**
 * 构建某天的量化指标。sessions 当天的学习条目；plan 整份计划；checkin 打卡表。
 */
export function computeMetrics({ date, sessions, plan, checkin, nowHHMM = null }) {
  const { slots } = day_plan(plan, date);
  const studySlots = slots.filter(s => s && typeof s === 'object'
    && !['休息', '锻炼'].includes(String(s.subject)));
  const plannedMin = planned_minutes(studySlots);

  const bySubject = {};
  let actualMin = 0;
  for (const s of sessions || []) {
    if (!s || typeof s !== 'object') continue;
    const m = s.duration || 0;
    if (!m) continue;
    actualMin += m;
    const k = String(s.subject || '其他');
    bySubject[k] = (bySubject[k] || 0) + m;
  }

  /* 块完成度近似：有时段表时，某科目当天有记录 ≈ 对应块完成了。
     条目没有时刻，按科目归账是最稳的下界。 */
  const subjectsDone = new Set(Object.keys(bySubject));
  let blocksDone = 0;
  for (const s of studySlots) {
    const until = nowHHMM ? String(nowHHMM) : '99:99';
    if (String(s.end || '99:99') > until) continue;      // 还没到点的块不算欠账
    if (subjectsDone.has(String(s.subject))) blocksDone++;
  }
  const blocksPast = nowHHMM
    ? studySlots.filter(s => String(s.end || '99:99') <= nowHHMM).length
    : studySlots.length;

  /* 连续学习天数（以「当天有记录」为准，含当天） */
  let streak = 0;
  let cur = date;
  const datesWith = new Set((sessions || []).map(s => s.date).filter(Boolean));
  // sessions 这里只传了当天的，算 streak 需要更长窗口 —— 由调用方传 streakIn 更准；
  // 没传就先按当天有无记录给 0/1。
  streak = datesWith.has(date) ? 1 : 0;

  const adherence = plannedMin > 0 ? Math.min(actualMin / plannedMin, 1) : null;

  return {
    plannedMin,
    actualMin,
    completionPct: adherence !== null ? Math.round(adherence * 100) : null,
    bySubject,
    blocksDone,
    blocksTotal: blocksPast,
    streak,
    slotsCount: studySlots.length
  };
}

/** 给日志补连续天数：用最近 8 天的台账算（computeMetrics 里只看得到当天） */
export function computeStreak(sessions, today) {
  const byDay = {};
  for (const s of sessions || []) {
    if (!s || typeof s !== 'object' || !s.date) continue;
    byDay[s.date] = (byDay[s.date] || 0) + (s.duration || 0);
  }
  let streak = 0;
  let cur = byDay[today] > 0 ? today : addDays(today, -1);
  while (byDay[cur] > 0) {
    streak++;
    cur = addDays(cur, -1);
  }
  return streak;
}

/**
 * 写一天日志：量化指标代码算 + AI 补全（没配 key 时用结构化模板兜底）。
 * 返回 { log }。
 */
export async function buildDayLog(env, { date, raw, source = 'chat' }) {
  const today = shanghaiToday();
  if (date > today) throw new Error('不能给未来写日志');
  if (date < addDays(today, -365)) throw new Error('太久了，只补一年以内的日志');

  const [{ data: plan }, { data: study }] = await Promise.all([
    readDoc(env, 'kaoyan'),
    readDoc(env, 'study')
  ]);
  const p = plan || {};
  const sd = study || {};
  const allSessions = Array.isArray(sd.sessions) ? sd.sessions : [];
  const daySessions = allSessions.filter(s => s && s.date === date);
  const hhmm = date === today ? shanghaiNowHHMM() : null;

  const metrics = computeMetrics({ date, sessions: daySessions, plan: p, checkin: sd.checkin, nowHHMM: hhmm });
  metrics.streak = computeStreak(allSessions, today);
  metrics.mood = parseMood(raw);
  metrics.checkedIn = !!(sd.checkin && sd.checkin[date]);

  const ai = await expandLog(env, { date, raw, plan: p, sessions: daySessions, metrics });

  return {
    log: {
      raw: String(raw || '').slice(0, 500),
      ai,
      metrics,
      source,
      createdAt: nowIso()
    }
  };
}

/** AI 补全：有 key 走 LLM，没 key 走结构化模板（都是「原话之上补全，不编造」） */
async function expandLog(env, { date, raw, plan, sessions, metrics }) {
  const planText = renderPlanBrief(plan, date);
  const sessionLines = sessions.length
    ? sessions.map(s => `· ${s.subject} ${fmt_minutes(s.duration || 0)}${s.content ? `（${s.content}）` : ''}`).join('\n')
    : '· （今天还没有学习记录）';
  const moodCn = { '好': '不错', '一般': '一般', '糟': '有点累/不顺' }[metrics.mood] || '没提';

  if (llmReady(env)) {
    try {
      return await llmChat(env, [
        { role: 'system', content: '你是考研学习日志的代笔。把用户最简短的原话，结合当天计划表和实际学习记录，'
          + '补成一篇完整但不编造的当日学习日志。\n'
          + '要求：\n'
          + '- 纯文本，180~320 字，一两段\n'
          + '- 以用户原话里的事实为骨料，计划表和记录只用来补上下文（比如「按计划该刷真题，实际完成了…」）\n'
          + '- 用户没说的细节不要编（不要发明具体页码/题号）\n'
          + '- 结尾带一句具体的明天建议（基于数据，不灌鸡汤）\n'
          + '- 语气像熟悉学生的学长，克制、具体' },
        { role: 'user', content: `日期：${date}\n用户原话：${raw || '（没写，只记录）'}\n心态：${moodCn}\n\n当天计划：\n${planText}\n\n当天学习记录：\n${sessionLines}\n\n量化：计划 ${metrics.plannedMin} 分钟，实际 ${metrics.actualMin} 分钟${metrics.completionPct !== null ? `（${metrics.completionPct}%）` : ''}，连续 ${metrics.streak} 天。` }
      ], { maxTokens: 800, temperature: 0.6 });
    } catch {
      /* LLM 挂了就落模板，日志不能因为代笔请假而丢 */
    }
  }

  /* 模板兜底 */
  const lines = [];
  if (raw) lines.push(`原话：${raw}`);
  lines.push(`学习 ${fmt_minutes(metrics.actualMin)}`);
  const subs = Object.entries(metrics.bySubject);
  if (subs.length) lines.push('科目：' + subs.map(([k, v]) => `${k} ${fmt_minutes(v)}`).join('，'));
  if (metrics.plannedMin > 0) {
    lines.push(`按计划 ${fmt_minutes(metrics.plannedMin)}，完成 ${metrics.completionPct}%`);
  }
  lines.push(`连续学习 ${metrics.streak} 天${metrics.checkedIn ? '，已打卡' : ''}`);
  lines.push(`心态：${moodCn}`);
  return lines.join('；') + '。';
}

function renderPlanBrief(plan, date) {
  const { slots, note } = day_plan(plan, date);
  if (!slots.length) return '（这天还没有安排）';
  return slots.map(s => `· ${s.start}-${s.end} ${s.subject}${s.topic ? `（${s.topic}）` : ''}`).join('\n')
    + (note ? `\n备注：${note}` : '');
}

function llmReady(env) {
  return !!env.LLM_API_KEY;
}

/** 读最近 N 天日志 */
export async function readLogs(env, days = 30) {
  const { data } = await readDoc(env, 'agent_logs');
  const logs = data && typeof data === 'object' && typeof data.logs === 'object' ? data.logs : {};
  const since = addDays(shanghaiToday(), -Math.max(1, Math.min(365, days)));
  const out = {};
  for (const [d, log] of Object.entries(logs)) {
    if (d >= since) out[d] = log;
  }
  return out;
}

/** 保存/覆盖一天日志 */
export async function saveLog(env, date, log) {
  const { data } = await readDoc(env, 'agent_logs');
  const doc = data && typeof data === 'object' ? data : {};
  doc.logs = doc.logs && typeof doc.logs === 'object' ? doc.logs : {};
  doc.logs[date] = log;
  /* 只留最近 400 天，防膨胀 */
  const keys = Object.keys(doc.logs).sort();
  while (keys.length > 400) delete doc.logs[keys.shift()];
  await writeDoc(env, 'agent_logs', doc);
}

/** 删一天日志（撤销用） */
export async function deleteLog(env, date) {
  const { data } = await readDoc(env, 'agent_logs');
  const doc = data && typeof data === 'object' ? data : {};
  doc.logs = doc.logs && typeof doc.logs === 'object' ? doc.logs : {};
  if (!doc.logs[date]) return false;
  delete doc.logs[date];
  await writeDoc(env, 'agent_logs', doc);
  return true;
}
