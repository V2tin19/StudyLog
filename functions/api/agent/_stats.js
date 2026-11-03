/**
 * _stats.js —— 计划数据模型的纯函数工具 + 统计 + 健康分
 * （自 kaoyan bot 的 planner.py 逐函数移植，用例在 tests/agent/_nlu.test.mjs）
 *
 * 计划 JSON 的结构（与 functions/api/admin/kaoyan-plan.js 的校验一致）：
 *   plan.examDate: "YYYY-MM-DD"
 *   plan.template: {"0"~"6": [slot...]}          每周模板（"0"=周日）
 *   plan.days:     {"YYYY-MM-DD": {"slots":[...], "note": ""}}   覆盖模板
 *
 * 这里所有函数都是纯的（chat / cron / learn 共用，也方便单测）。
 * 日期用 'YYYY-MM-DD' 字符串，加减法走 _nlu.js 的天序号工具。
 */

import { addDays, weekdayPy, shanghaiToday, shanghaiNowHHMM } from './_nlu.js';

export const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export const SUBJECTS_408 = ['数学', '英语', '政治', '数据结构', '操作系统',
  '计算机组成原理', '计算机网络'];

const _TIME_RE = /^\d{1,2}:\d{2}$/;

export function toMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

/* ---------------------------------------------------------------
 * 计划读取 / 渲染
 * --------------------------------------------------------------- */

/** date → 模板键 '0'~'6'（'0' 是周日，与网页端 Extras 一致） */
export function template_key(dateStr) {
  return String((weekdayPy(dateStr) + 1) % 7);
}

/** 某天的计划：days 优先，落到 template，都没有返回 { slots: [], note: '' } */
export function day_plan(plan, dateStr) {
  plan = plan || {};
  const day = (plan.days || {})[dateStr];
  if (day && typeof day === 'object') {
    return { slots: Array.isArray(day.slots) ? [...day.slots] : [], note: String(day.note || '') };
  }
  const tpl = (plan.template || {})[template_key(dateStr)];
  if (Array.isArray(tpl)) return { slots: [...tpl], note: '' };
  return { slots: [], note: '' };
}

/** 计划时段的总分钟数（休息也计入，它占的是日历时间） */
export function planned_minutes(slots) {
  let total = 0;
  for (const s of slots || []) {
    if (s && typeof s === 'object' && _TIME_RE.test(String(s.start || '')) && _TIME_RE.test(String(s.end || ''))) {
      const mins = toMinutes(s.end) - toMinutes(s.start);
      if (mins > 0) total += mins;
    }
  }
  return total;
}

export function fmt_minutes(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  return h ? `${h}小时${mm}分钟` : `${mm}分钟`;
}

/** 把一天的计划渲染成文本消息。nowHHMM 传入时用当前时间标「现在/已过」。 */
export function render_day(dateStr, slots, note = '', nowHHMM = null) {
  const lines = [`📌 ${dateStr} ${WEEKDAY_CN[weekdayPy(dateStr)]}`];
  if (!slots || !slots.length) {
    lines.push('（这天还没有安排）');
    if (note) lines.push(`备注：${note}`);
    return lines.join('\n');
  }
  for (const s of slots) {
    if (!s || typeof s !== 'object') continue;
    let mark = '';
    if (nowHHMM) {
      if (String(s.end || '') <= nowHHMM) mark = ' ✅';
      else if (String(s.start || '') <= nowHHMM) mark = ' 🔔';
    }
    const topic = s.topic ? `｜${s.topic}` : '';
    const dur = _TIME_RE.test(String(s.start || '')) && _TIME_RE.test(String(s.end || ''))
      ? `（${fmt_minutes(planned_minutes([s]))}）` : '';
    lines.push(`${s.start || '??:??'}-${s.end || '??:??'}${dur} ${s.subject || '?'}${topic}${mark}`);
  }
  if (note) lines.push(`📝 ${note}`);
  return lines.join('\n');
}

/** 考试倒计时文案；没设考试日期返回 null */
export function countdown_text(plan, today) {
  const exam = (plan || {}).examDate;
  if (!exam || !/^\d{4}-\d{2}-\d{2}$/.test(String(exam))) return null;
  const diff = Math.round((Date.UTC(+exam.slice(0, 4), +exam.slice(5, 7) - 1, +exam.slice(8, 10))
    - Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10))) / 86400000);
  if (diff < 0) return '考试已经结束，祝上岸顺利 🎉';
  if (diff === 0) return '🎯 今天就是考试日，稳住，你能行！';
  return `⏳ 距离初试（${exam}）还有 ${diff} 天`;
}

/* ---------------------------------------------------------------
 * 统计（周报 & 健康分的数据都在这算，LLM 只负责说话）
 * --------------------------------------------------------------- */

/** 最近 days 天（含今天）的日期列表与边界 */
export function week_window(today, days = 7) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(addDays(today, -i));
  return { dates, start: dates[0], end: dates[dates.length - 1] };
}

/** 最近 7 天的统计。sessions 是云端返回的记录列表（可能带任意字段）。 */
export function week_stats(sessions, checkin, plan, today, weekly_target_minutes = 2940) {
  const { dates } = week_window(today);
  const dateSet = new Set(dates);

  const by_day = {};
  for (const d of dates) by_day[d] = 0;
  const by_subject = {};
  for (const s of sessions || []) {
    if (!s || typeof s !== 'object') continue;
    const d = String(s.date || '');
    if (!dateSet.has(d)) continue;
    let mins = s.duration != null ? s.duration : (s.minutes || 0);
    mins = parseInt(mins, 10);
    if (Number.isNaN(mins)) continue;
    by_day[d] += mins;
    const subj = String(s.subject || '其他');
    by_subject[subj] = (by_subject[subj] || 0) + mins;
  }

  const active_days = dates.filter(d => by_day[d] > 0).length;
  const total = dates.reduce((a, d) => a + by_day[d], 0);

  /* 连续学习天数（今天或昨天截止） */
  let streak = 0;
  let cur = by_day[today] > 0 ? today : addDays(today, -1);
  while (by_day[cur] > 0) {
    streak++;
    cur = addDays(cur, -1);
  }

  /* 计划符合度：只统计「那天有计划」的日子（min(实际/计划, 1) 的平均） */
  const adherences = [];
  for (const d of dates) {
    const { slots } = day_plan(plan, d);
    const planned = planned_minutes(slots.filter(s => s && typeof s === 'object'
      && !['休息', '锻炼'].includes(String(s.subject))));
    if (planned > 0) adherences.push(Math.min(by_day[d] / planned, 1.0));
  }
  const adherence = adherences.length ? adherences.reduce((a, b) => a + b, 0) / adherences.length : null;

  const checkin_days = dates.filter(d => (checkin || {})[d]).length;

  const by_subject_sorted = {};
  Object.entries(by_subject).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => { by_subject_sorted[k] = v; });

  return {
    start: dates[0], end: dates[dates.length - 1],
    by_day,
    by_subject: by_subject_sorted,
    total_minutes: total,
    active_days,
    streak,
    checkin_days,
    adherence: adherence !== null ? Math.round(adherence * 100) / 100 : null,
    daily_avg_minutes: Math.round(total / dates.length),
    weekly_target_minutes
  };
}

/** 健康分 0~100。
 *
 * 构成：时长达成 30 + 出勤 25 + 计划符合 20 + 连续性 15 + 心态 10
 * moods: 最近 7 天日记的 mood 字符串列表（好/一般/糟 一类的词）
 */
export function health_score(stats, moods) {
  const target = stats.weekly_target_minutes || 2940;
  const s_time = Math.min(stats.total_minutes / Math.max(target, 1), 1.0) * 30;
  const s_days = stats.active_days / 7 * 25;
  const s_adh = (stats.adherence != null ? stats.adherence : 0.5) * 20;
  const s_streak = Math.min(stats.streak, 7) / 7 * 15;

  const POS = ['好', '棒', '开心', '不错', '很好', '充实', '满'];
  const MID = ['一般', '还行', '普通', '平平'];
  const score_vals = [];
  for (let m of moods || []) {
    m = String(m || '');
    if (!m) continue;
    if (POS.some(p => m.includes(p))) score_vals.push(2.0);
    else if (MID.some(p => m.includes(p))) score_vals.push(1.0);
    else score_vals.push(0.0);
  }
  const mood_avg = score_vals.length ? score_vals.reduce((a, b) => a + b, 0) / score_vals.length : null;
  const s_mood = mood_avg !== null ? (mood_avg / 2 * 10) : 5.0;

  const total = Math.round(s_time + s_days + s_adh + s_streak + s_mood);
  let label;
  if (total >= 85) label = '满血 🔥';
  else if (total >= 70) label = '良好 💪';
  else if (total >= 55) label = '一般 😐';
  else if (total >= 40) label = '疲劳 ⚠️';
  else label = '需要休息 🩺';

  return {
    score: total,
    label,
    breakdown: {
      '时长达成': Math.round(s_time), '出勤': Math.round(s_days),
      '计划符合': Math.round(s_adh), '连续性': Math.round(s_streak),
      '心态': Math.round(s_mood * 10) / 10
    },
    mood_avg: mood_avg !== null ? Math.round(mood_avg * 100) / 100 : null
  };
}

/* 便捷：今天 + 当前 HH:MM（北京时区），chat/cron 里组装上下文用 */
export function beijingNow() {
  return { today: shanghaiToday(), hhmm: shanghaiNowHHMM() };
}
