/**
 * _scheduler.test.mjs —— 排期引擎的断言测试
 * 跑法：node tests/agent/_scheduler.test.mjs
 */

import { allocateDay, resolve_plan_day, extract_plan_day, toMin, fromMin } from '../../functions/api/agent/_scheduler.js';

const FAILS = [];
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { FAILS.push(name); console.log(`FAIL  ${name}  ${detail}`); }
}

const day = '2026-11-04';

/* ---------------- 基础切块 ---------------- */
console.log('== allocateDay 基础 ==');

let r = allocateDay({
  date: day, existingSlots: [],
  allocations: [{ subject: '数学', minutes: 120 }],
  profile: { schedule: { wake: '08:00', sleep: '23:30' } }
});
check('120 分钟切成 90+30 两块', r.slots.length === 2
  && r.slots[0].start === '08:00' && r.slots[0].end === '09:30'
  && r.slots[1].start === '09:40' && r.slots[1].end === '10:10', JSON.stringify(r.slots));
check('无未排余量', r.unplaced.length === 0);
check('块间留 10 分钟休息', toMin(r.slots[1].start) - toMin(r.slots[0].end) === 10);

r = allocateDay({
  date: day, existingSlots: [],
  allocations: [{ subject: '英语', minutes: 100 }],
  profile: { schedule: { wake: '08:00', sleep: '23:30' } }
});
check('小尾巴并入一块（100 → 08:00-09:40）', r.slots.length === 1
  && r.slots[0].start === '08:00' && r.slots[0].end === '09:40', JSON.stringify(r.slots));

/* ---------------- 已有时段不被侵占 ---------------- */
console.log('== 避开已有时段 ==');

r = allocateDay({
  date: day,
  existingSlots: [{ start: '08:00', end: '12:00', subject: '数学' }],
  allocations: [{ subject: '英语', minutes: 60 }],
  profile: { schedule: { wake: '08:00', sleep: '23:30' } }
});
check('占用后的第一个空窗', r.slots.length === 1
  && r.slots[0].start === '12:00' && r.slots[0].end === '13:00', JSON.stringify(r.slots));

r = allocateDay({
  date: day,
  existingSlots: [
    { start: '08:00', end: '10:00', subject: '数学' },
    { start: '14:00', end: '16:00', subject: '英语' }
  ],
  allocations: [{ subject: '政治', minutes: 90 }],
  profile: { schedule: { wake: '08:00', sleep: '23:30' } }
});
check('钻进 10:00-14:00 的缝（90 ≤ 240）', r.slots.length === 1
  && r.slots[0].start === '10:00' && r.slots[0].end === '11:30', JSON.stringify(r.slots));

/* ---------------- 从当前时间往后排 ---------------- */
console.log('== nowHHMM ==');

r = allocateDay({
  date: day, existingSlots: [],
  allocations: [{ subject: '英语', minutes: 90 }],
  profile: { schedule: { wake: '08:00', sleep: '23:30' } },
  nowHHMM: '20:02'
});
check('从当前时间取整 5 分钟开始', r.slots.length === 1
  && r.slots[0].start === '20:05' && r.slots[0].end === '21:35', JSON.stringify(r.slots));

r = allocateDay({
  date: day, existingSlots: [],
  allocations: [{ subject: '数学', minutes: 120 }],
  profile: { schedule: { wake: '08:00', sleep: '23:30' } },
  nowHHMM: '22:00'
});
check('睡前空间不足 → 排得下的 + unplaced', r.slots.length === 1
  && r.slots[0].start === '22:00' && r.slots[0].end === '23:30'
  && r.unplaced.length === 1 && r.unplaced[0].minutes === 30, JSON.stringify(r));

r = allocateDay({
  date: day, existingSlots: [],
  allocations: [{ subject: '数学', minutes: 60 }],
  profile: { schedule: { wake: '08:00', sleep: '23:30' } },
  nowHHMM: '23:40'
});
check('过了睡觉点 → 全部 unplaced', r.slots.length === 0 && r.unplaced[0].minutes === 60, JSON.stringify(r));

/* ---------------- 多个分配按顺序、互不重叠 ---------------- */
console.log('== 多分配 ==');

r = allocateDay({
  date: day, existingSlots: [],
  allocations: [
    { subject: '数学', minutes: 120, taskId: 't1' },
    { subject: '英语', minutes: 60 }
  ],
  profile: { schedule: { wake: '08:00', sleep: '23:30' } }
});
const starts = r.slots.map(s => toMin(s.start));
const ends = r.slots.map(s => toMin(s.end));
let noOverlap = true;
for (let i = 1; i < r.slots.length; i++) {
  if (starts[i] < ends[i - 1]) noOverlap = false;
}
check('互不重叠', noOverlap, JSON.stringify(r.slots));
check('数学在前英语在后', r.slots[0].subject === '数学' && r.slots[r.slots.length - 1].subject === '英语');
check('task_id 落到块上', r.slots.every(s => s.task_id === 't1' ? s.subject === '数学' : true)
  && r.slots.some(s => s.task_id === 't1'));
const total = ends[ends.length - 1] - starts[0] - 10;   // 减一次块间休息
check('总时长守恒（含休息 190）', total === 190, String(total));

/* ---------------- 习惯偏好窗 ---------------- */
console.log('== 偏好窗 ==');

r = allocateDay({
  date: day, existingSlots: [],
  allocations: [{ subject: '数学', minutes: 60 }],
  profile: {
    schedule: { wake: '08:00', sleep: '23:30' },
    habits: { subjectWindows: { '数学': [['08:00', '11:00']] } }
  }
});
check('偏好窗优先（14:00 的空窗不用，落 08:00）', r.slots[0].start === '08:00', JSON.stringify(r.slots));

/* 偏好窗被占满时回落到普通窗 */
r = allocateDay({
  date: day,
  existingSlots: [{ start: '08:00', end: '11:00', subject: '其他' }],
  allocations: [{ subject: '数学', minutes: 60 }],
  profile: {
    schedule: { wake: '08:00', sleep: '23:30' },
    habits: { subjectWindows: { '数学': [['08:00', '11:00']] } }
  }
});
check('偏好窗被占 → 回落最早空窗', r.slots[0].start === '11:00', JSON.stringify(r.slots));

/* ---------------- 日期解析（排期可以往后） ---------------- */
console.log('== resolve_plan_day / extract_plan_day ==');

r = resolve_plan_day('tomorrow', day);
check('明天', r.date === '2026-11-05' && r.note === '明天');
r = resolve_plan_day('day_after', day);
check('后天', r.date === '2026-11-06');
r = resolve_plan_day('next_weekday:5', day);   // 11-04 是周三，下一个周六 = 11-07
check('下一个周六', r.date === '2026-11-07', `got ${r.date}`);
r = resolve_plan_day('next_weekday:2', day);   // 说周三 → 就是今天
check('说今天的周几 → 今天', r.date === day);
r = resolve_plan_day('2026-12-01', day);
check('未来日期允许', r.date === '2026-12-01');
r = resolve_plan_day('2026-10-01', day);
check('过去日期拒绝', r.date === null);
r = resolve_plan_day('2027-02-01', day);
check('60 天以外拒绝', r.date === null);

check('extract 大后天', extract_plan_day('大后天要模考', day) === 'three_days');
check('extract 明天', extract_plan_day('明天学数学', day) === 'tomorrow');
check('extract 周六', extract_plan_day('周六练套卷', day) === 'next_weekday:5');
check('extract 默认今天', extract_plan_day('学数学两小时', day) === 'today');

console.log('');
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} 个用例失败：${FAILS.join('、')}`);
  process.exit(1);
}
console.log('✅ 全部通过');
