/**
 * /api/admin/agent/learn —— 习惯聚合（夜间跑，或手动触发）
 *
 *   POST /api/admin/agent/learn     从学习台账 + 计划聚合出习惯画像，写入 agent_profile.habits
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 *
 * v1 口径（诚实版，不玄学）：
 * - actualStartTime：最近 14 天每天第一条记录的创建时刻（北京 HH:MM）取中位数
 *   —— 用户「实际开始学习」的时间，推送时机往它前面靠。
 * - avgDailyMinutes / activeRate：最近 14 天日均时长与出勤率。
 * - bySubject：各科目近 14 天总时长与天数（谁在吃灰一眼可见）。
 * - subjectWindows：按近 14 天各科目记录落在上午/下午/晚上的比例，
 *   给每个高频科目生成偏好窗（喂给排期引擎的 subjectWindows）。
 * - skippedSubjects：近 7 天「排了块但当天该科目零记录」的科目计数（提醒素材）。
 */

import { json, dbMissing, requireAdmin } from '../../_shared.js';
import { readDoc, writeDoc, nowIso } from '../../agent/_store.js';
import { shanghaiToday, addDays } from '../../agent/_nlu.js';
import { day_plan } from '../../agent/_stats.js';

const NO_STORE = { 'cache-control': 'no-store' };
const WINDOW_DAYS = 14;

function beijingHM(iso) {
  /* createdAt 是 UTC ISO；转北京 HH:MM */
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const b = new Date(d.getTime() + 8 * 3600 * 1000);
  return b.toISOString().slice(11, 16);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort();
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function timeBucket(hhmm) {
  const h = +String(hhmm || '').slice(0, 2);
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/** 聚合习惯画像并写入 agent_profile.habits。返回 { habits, summary } */
export async function runLearn(env) {
  const today = shanghaiToday();
  const since = addDays(today, -(WINDOW_DAYS - 1));

  const [{ data: study }, { data: plan }, { data: profile }] = await Promise.all([
    readDoc(env, 'study'),
    readDoc(env, 'kaoyan'),
    readDoc(env, 'agent_profile')
  ]);
  const sessions = (study && Array.isArray(study.sessions)) ? study.sessions.filter(s => s && s.date && s.date >= since) : [];
  const p = profile && typeof profile === 'object' ? profile : {};
  p.schedule = p.schedule && typeof p.schedule === 'object' ? p.schedule : { wake: '08:00', sleep: '23:30', weeklyTargetMinutes: 2940 };
  p.prefs = Array.isArray(p.prefs) ? p.prefs : [];

  /* ---- 实际开始时间 ---- */
  const byDayFirst = {};
  for (const s of sessions) {
    const hm = beijingHM(s.createdAt);
    if (!hm) continue;
    if (!byDayFirst[s.date] || hm < byDayFirst[s.date]) byDayFirst[s.date] = hm;
  }
  const starts = Object.values(byDayFirst);

  /* ---- 日均 / 出勤 ---- */
  const daysWithStudy = new Set(sessions.map(s => s.date));
  const totalMin = sessions.reduce((a, s) => a + (s.duration || 0), 0);

  /* ---- 科目分布 + 偏好窗 ---- */
  const bySubject = {};
  const buckets = {};
  for (const s of sessions) {
    const k = String(s.subject || '其他');
    bySubject[k] = bySubject[k] || { minutes: 0, days: new Set() };
    bySubject[k].minutes += s.duration || 0;
    bySubject[k].days.add(s.date);
    const hm = beijingHM(s.createdAt);
    if (hm) {
      buckets[k] = buckets[k] || { morning: 0, afternoon: 0, evening: 0 };
      buckets[k][timeBucket(hm)]++;
    }
  }
  const subjectWindows = {};
  for (const [k, b] of Object.entries(buckets)) {
    const total = b.morning + b.afternoon + b.evening;
    if (total < 3) continue;                       /* 样本太少不立偏好 */
    const top = Object.entries(b).sort((x, y) => y[1] - x[1])[0];
    if (top[1] / total < 0.6) continue;            /* 习惯不够偏就不硬猜 */
    const win = top[0] === 'morning' ? ['08:00', '12:00']
      : top[0] === 'afternoon' ? ['14:00', '18:00'] : ['18:30', '22:30'];
    subjectWindows[k] = [win];
  }

  /* ---- 排了但没做的科目（近 7 天） ---- */
  const skipped = {};
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, -i);
    if (d >= today) continue;                      /* 今天还没过完不算 */
    const { slots } = day_plan(plan || {}, d);
    for (const s of slots) {
      if (!s || typeof s !== 'object' || ['休息', '锻炼'].includes(String(s.subject))) continue;
      const has = sessions.some(x => x.date === d && x.subject === s.subject);
      if (!has) skipped[String(s.subject)] = (skipped[String(s.subject)] || 0) + 1;
    }
  }

  p.habits = {
    computedAt: nowIso(),
    windowDays: WINDOW_DAYS,
    actualStartTime: median(starts),
    startSamples: starts.length,
    avgDailyMinutes: Math.round(totalMin / WINDOW_DAYS),
    activeDays: daysWithStudy.size,
    activeRate: Math.round(daysWithStudy.size / WINDOW_DAYS * 100),
    bySubject: Object.fromEntries(Object.entries(bySubject).map(([k, v]) =>
      [k, { minutes: v.minutes, days: v.days.size }])),
    subjectWindows,
    skippedSubjects: skipped
  };
  p.updatedAt = nowIso();
  await writeDoc(env, 'agent_profile', p);

  return {
    habits: p.habits,
    summary: `近${WINDOW_DAYS}天：出勤 ${p.habits.activeDays} 天，日均 ${p.habits.avgDailyMinutes} 分钟，`
      + `实际开始 ${p.habits.actualStartTime || '无数据'}，偏好窗 ${Object.keys(subjectWindows).join('、') || '暂无'}`
  };
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const { habits, summary } = await runLearn(env);
  return json({ ok: true, habits, summary }, 200, NO_STORE);
}
