/**
 * _scheduler.js —— 确定性排期引擎（纯函数）
 *
 * 输入：某天的已有时段 + 一组待排分配（{subject, minutes, taskId?}）+ 作息边界 + 习惯偏好
 * 输出：塞进空闲窗的时间块（不重叠、不过 23:30、大块切分带间隔）
 *
 * 设计原则（与 kaoyan bot 的 gen_week/adjust_day 纪律一致）：
 * - 确定性优先：能算的不问 LLM；LLM 只在「重排本周/按状态调整」里做内容细化，
 *   且产物必须过服务端校验（见 _agent.js 的 validateSlots）。
 * - 已有时段永不被这里改动 —— 排期是「往空档里填」，不是重排。
 *   要重排走反馈调整（_adjustDay），那里有独立快照可撤销。
 *
 * 块规则：单块目标 ≤90 分钟；剩 <20 分钟的尾巴并入上一块（避免 10 分钟碎块）；
 * 块间留 10 分钟休息；15 分钟以下的零头不排（没用）。
 */

import { dayNum, fromDayNum, weekdayPy } from './_nlu.js';

export function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return null;
  const n = +m[1] * 60 + +m[2];
  return (n >= 0 && n <= 24 * 60) ? n : null;
}

export function fromMin(n) {
  const h = Math.floor(n / 60), m = n % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 排某一天。
 * @param {object} input
 *   date:          'YYYY-MM-DD'
 *   existingSlots: 当天已有时段（原样保留）
 *   allocations:   [{ subject, minutes, taskId?, topic? }]（按优先级排好序传入）
 *   profile:       agent_profile doc（schedule.wake/sleep，habits.subjectWindows 可选）
 *   nowHHMM:       排今天时传当前 HH:MM（过去的时段不用）；排明天传 null
 *   limits:        { minBlock=15, maxBlock=90, breakMin=10, tailMerge=20 } 可调
 * @returns {{ slots: Array, placed: Array, unplaced: Array }}
 *   slots: 新生成的时段（已按 start 排序）
 *   placed: [{ subject, minutes }] 实际排上的
 *   unplaced: [{ subject, minutes }] 没排下的
 */
export function allocateDay(input) {
  const {
    date, existingSlots = [], allocations = [], profile = {}, nowHHMM = null,
    limits = {}
  } = input;
  const minBlock = limits.minBlock ?? 15;
  const maxBlock = limits.maxBlock ?? 90;
  const breakMin = limits.breakMin ?? 10;
  const tailMerge = limits.tailMerge ?? 20;

  /* ---- 作息边界 ---- */
  const sched = (profile && profile.schedule) || {};
  let lower = toMin(sched.wake) ?? 8 * 60;
  const upper = toMin(sched.sleep) ?? 23 * 60 + 30;
  if (nowHHMM) {
    const now = toMin(nowHHMM) ?? 0;
    /* 向上取整到 5 分钟，别排出 14:03 这种别扭起点 */
    lower = Math.max(lower, Math.ceil(now / 5) * 5);
  }
  if (upper <= lower) {
    return { slots: [], placed: [], unplaced: allocations.map(a => ({ subject: a.subject, minutes: a.minutes })) };
  }

  /* ---- 空闲窗 = [lower, upper] 减去已有时段 ---- */
  const occupied = (existingSlots || [])
    .map(s => {
      const a = toMin(s && s.start), b = toMin(s && s.end);
      return (a !== null && b !== null && b > a) ? [a, b] : null;
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);

  let free = [];
  let cursor = lower;
  for (const [a, b] of occupied) {
    if (b <= lower || a >= upper) continue;             /* 不相干 */
    const ca = Math.max(a, lower), cb = Math.min(b, upper);
    if (ca > cursor) free.push([cursor, ca]);
    cursor = Math.max(cursor, cb);
  }
  if (cursor < upper) free.push([cursor, upper]);

  /* ---- 习惯偏好钩子：科目偏好的时段窗（M4 的 learn 填充） ----
     选窗规则：有偏好的科目优先落进最早的「与偏好窗有重叠」的空闲窗；
     没有偏好或没有重叠就按时间顺序取最早的窗。 */
  const preferMap = (profile && profile.habits && profile.habits.subjectWindows) || {};
  const work = free.map(([a, b]) => ({ a, b }));

  const pickWin = (subject, need) => {
    const idxs = [];
    for (let i = 0; i < work.length; i++) {
      if (work[i].b - work[i].a >= need) idxs.push(i);
    }
    if (!idxs.length) return -1;
    const pref = preferMap[subject];
    if (Array.isArray(pref) && pref.length) {
      const ranges = pref.map(p => [toMin(p && p[0]) ?? 0, toMin(p && p[1]) ?? 0]);
      const withOverlap = idxs.filter(i =>
        ranges.some(([pa, pb]) => Math.min(work[i].b, pb) - Math.max(work[i].a, pa) > 0));
      if (withOverlap.length) return withOverlap[0];
    }
    return idxs[0];
  };

  const newSlots = [];
  const placed = [];
  const unplaced = [];

  for (const alloc of allocations) {
    let remaining = Math.max(0, Math.round(alloc.minutes || 0));
    if (!remaining) continue;
    const subject = String(alloc.subject || '学习').slice(0, 60);

    while (remaining > 0) {
      const wi = pickWin(subject, Math.min(minBlock, remaining));
      if (wi === -1) break;
      const { a, b } = work[wi];

      let len = Math.min(remaining, maxBlock);
      let nextRemaining = remaining - len;
      /* 小尾巴：剩 <20 分钟且本窗装得下剩余全部 → 一块放完，避免 10 分钟碎块 */
      if (nextRemaining > 0 && nextRemaining < tailMerge && (b - a) >= remaining) {
        len = remaining;
        nextRemaining = 0;
      }
      if (len < minBlock) { work.splice(wi, 1); continue; }   /* 窗太小，换下一个 */

      const slot = {
        start: fromMin(a),
        end: fromMin(a + len),
        subject,
        status: 'todo'
      };
      if (alloc.taskId) slot.task_id = alloc.taskId;
      if (alloc.topic) slot.topic = String(alloc.topic).slice(0, 500);
      newSlots.push(slot);

      remaining = nextRemaining;
      /* 每块之后都留休息间隔 —— 下一个分配（可能是别的科目）也需要喘口气 */
      const nextStart = a + len + breakMin;
      if (nextStart >= b) {
        work.splice(wi, 1);                                  /* 窗用完 */
      } else {
        work[wi] = { a: nextStart, b };
      }
    }

    if (remaining > 0) unplaced.push({ subject, minutes: remaining });
    else placed.push({ subject, minutes: Math.round(alloc.minutes) });
  }

  newSlots.sort((x, y) => toMin(x.start) - toMin(y.start));
  return { slots: newSlots, placed, unplaced };
}

/* ---------------------------------------------------------------
 * 排期的日期解析（计划可以排未来，学习记录不行 —— 两个入口）
 * --------------------------------------------------------------- */

/**
 * plan day 标记 → 日期。允许未来（≤60 天）。
 * token: today / tomorrow / day_after / three_days / next_weekday:N / YYYY-MM-DD / null
 */
export function resolve_plan_day(token, today) {
  const t = dayNum(today);
  if (Number.isNaN(t)) return { date: null, note: `today 不合法：${today}` };
  if (token === null || token === undefined || token === '' || token === 'today') {
    return { date: today, note: '今天' };
  }
  token = String(token).trim().toLowerCase();
  const offMap = { tomorrow: 1, day_after: 2, three_days: 3 };
  if (offMap[token] !== undefined) {
    return { date: fromDayNum(t + offMap[token]), note: token === 'tomorrow' ? '明天' : `${offMap[token]}天后` };
  }
  let m = /^next_weekday:([0-6])$/.exec(token);
  if (m) {
    const target = parseInt(m[1], 10);
    const delta = ((target - weekdayPy(today)) % 7 + 7) % 7;
    return { date: fromDayNum(t + delta), note: '周' + '一二三四五六日'[target] + (delta === 0 ? '（今天）' : '') };
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
  if (m) {
    const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const d = dayNum(iso);
    if (Number.isNaN(d)) return { date: null, note: `日期不存在：${token}` };
    if (d < t) return { date: null, note: `${iso} 已经过去了，排期要排今天以后` };
    if (d - t > 60) return { date: null, note: '最多排 60 天以内' };
    return { date: iso, note: iso };
  }
  return { date: null, note: `认不出这个排期日期标记：${token}` };
}

/** 从排期请求文本里抽日期词（明天/后天/大后天/周X/X月X日 → plan day 标记） */
export function extract_plan_day(text, today) {
  today = today || '';
  if (/大后天/.test(text)) return 'three_days';
  if (/后天/.test(text)) return 'day_after';
  if (/明天|明儿/.test(text)) return 'tomorrow';
  let m = /(\d{1,2})月(\d{1,2})[日号]/.exec(text);
  if (m) {
    const year = today ? +today.slice(0, 4) : new Date().getUTCFullYear();
    const t = today ? dayNum(today) : 0;
    let iso = `${year}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
    let d = dayNum(iso);
    if (!Number.isNaN(d) && !Number.isNaN(t) && d < t) {
      iso = `${year + 1}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
    }
    return iso;
  }
  m = /(?:下?周|下?星期|下?礼拜)([一二三四五六日天])/.exec(text);
  if (m) {
    const idx = '一二三四五六日天'.indexOf(m[1]) % 7;
    return `next_weekday:${idx}`;
  }
  return 'today';
}
