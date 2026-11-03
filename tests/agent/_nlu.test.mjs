/**
 * _nlu.test.mjs —— nlu / stats 的断言测试（自 kaoyan bot 的 test_core.py 移植）
 *
 * 覆盖用户红线：日期归属必须正确（当天的记到当天）。
 * 跑法：node tests/agent/_nlu.test.mjs
 */

import assert from 'node:assert';
import {
  cn2num, resolve_day_token, extract_day_token, try_parse_log
} from '../../functions/api/agent/_nlu.js';
import {
  day_plan, planned_minutes, fmt_minutes, countdown_text, render_day,
  week_stats, health_score
} from '../../functions/api/agent/_stats.js';

const FAILS = [];

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    FAILS.push(name);
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

const TODAY = '2026-10-31';          // 周六（python weekday()=5）
const WED = '2026-10-28';            // 周三
const d = (s) => s;                  // 可读性：日期直接用字符串字面量

/* ---------------- 日期标记解析 ---------------- */
console.log('== resolve_day_token ==');
let r = resolve_day_token(null, TODAY);
check('None -> 今天', r.date === d('2026-10-31'));
r = resolve_day_token('yesterday', TODAY);
check('yesterday -> 昨天', r.date === d('2026-10-30') && r.note === '昨天');
r = resolve_day_token('before_yesterday', TODAY);
check('before_yesterday -> 前天', r.date === d('2026-10-29'));
r = resolve_day_token('day_offset:-3', TODAY);
check('大前天', r.date === d('2026-10-28'));
/* 今天是周六，说「周四学的」→ 最近过去的周四 = 2 天前 */
r = resolve_day_token('weekday:3', TODAY);
check('周六说周四 -> 两天前', r.date === d('2026-10-29'), `got ${r.date}`);
/* 今天是周三，说「周四学的」→ 上周四（未来不可记） */
r = resolve_day_token('weekday:3', WED);
check('周三说周四 -> 上周四', r.date === d('2026-10-22'), `got ${r.date}`);
/* 今天周六说「周六学的」→ 就是今天 */
r = resolve_day_token('weekday:5', TODAY);
check('周六说周六 -> 今天', r.date === TODAY);
/* 明确日期（过去） */
r = resolve_day_token('2026-10-15', TODAY);
check('明确过去日期', r.date === d('2026-10-15'));
/* 明确日期（未来）→ 拒绝（带年份的明确未来日期，绝不滚去年） */
r = resolve_day_token('2026-12-26', TODAY);
check('未来日期拒绝', r.date === null, `got ${r.date} ${r.note}`);
r = resolve_day_token('2027-10-31', TODAY);
check('远未来日期拒绝', r.date === null);
/* 不存在的日期 */
r = resolve_day_token('2026-02-30', TODAY);
check('不存在日期拒绝', r.date === null);
/* 超过一年 */
r = resolve_day_token('2025-01-01', TODAY);
check('超过一年拒绝', r.date === null);

/* ---------------- 中文数字 ---------------- */
console.log('== cn2num ==');
check('两', cn2num('两') === 2);
check('俩', cn2num('俩') === 2);
check('十五', cn2num('十五') === 15);
check('二十', cn2num('二十') === 20);
check('1.5', cn2num('1.5') === 1.5);
check('乱码', cn2num('abc') === null);

/* ---------------- 日期词抽取 ---------------- */
console.log('== extract_day_token ==');
let e = extract_day_token('今天下午学了2小时数据结构', TODAY);
check('今天', e.token === 'today' && !e.rest.includes('今天'));
e = extract_day_token('昨天晚上背了1小时单词', TODAY);
check('昨晚 -> yesterday', e.token === 'yesterday');
e = extract_day_token('周三学了高数', TODAY);
check('周三 -> weekday:2', e.token === 'weekday:2', `got ${e.token}`);
e = extract_day_token('10月28号刷了题', TODAY);
check('10月28号 -> 过去日期', e.token === '2026-10-28', `got ${e.token}`);
e = extract_day_token('3月1号学的', TODAY);
check('今年3月1号(过去)', e.token === '2026-03-01', `got ${e.token}`);
e = extract_day_token('12月26号学的', TODAY);
check('12月26号(未来) -> 去年', e.token === '2025-12-26', `got ${e.token}`);

/* ---------------- 学习记录快车道 ---------------- */
console.log('== try_parse_log ==');

r = try_parse_log('今天下午学了2小时数据结构，刷了王道课后题', TODAY);
check('常规句', r && r.subject === '数据结构' && r.minutes === 120
  && r.day_token === 'today' && (r.content || '').includes('王道'), `got ${JSON.stringify(r)}`);

r = try_parse_log('昨天晚上背了1小时单词', TODAY);
check('昨天+单词', r && r.subject === '英语' && r.minutes === 60
  && r.day_token === 'yesterday', `got ${JSON.stringify(r)}`);

r = try_parse_log('学了俩小时', TODAY);
check('无科目但有学', r && r.minutes === 120 && r.subject === '其他', `got ${JSON.stringify(r)}`);

r = try_parse_log('刷了半小时408真题', TODAY);
check('半小时+408', r && r.minutes === 30 && r.subject === '408', `got ${JSON.stringify(r)}`);

r = try_parse_log('昨晚复习了1.5小时高数', TODAY);
check('1.5小时+高数', r && r.minutes === 90 && r.subject === '数学'
  && r.day_token === 'yesterday', `got ${JSON.stringify(r)}`);

r = try_parse_log('一个半小时线代', TODAY);
check('一个半小时', r && r.minutes === 90 && r.subject === '数学', `got ${JSON.stringify(r)}`);

r = try_parse_log('90分钟操作系统', TODAY);
check('90分钟', r && r.minutes === 90 && r.subject === '操作系统', `got ${JSON.stringify(r)}`);

r = try_parse_log('看了2小时网课', TODAY);
check('看了2小时网课', r && r.minutes === 120 && r.subject === '其他', `got ${JSON.stringify(r)}`);

r = try_parse_log('玩了2小时手机', TODAY);
check('玩手机的拦截', r === null, `got ${JSON.stringify(r)}`);

r = try_parse_log('今天心情不错', TODAY);
check('无时长不误记', r === null, `got ${JSON.stringify(r)}`);

r = try_parse_log('状态不好，帮我把计划松一点', TODAY);
check('状态反馈不误记', r === null, `got ${JSON.stringify(r)}`);

r = try_parse_log('周日整理了3小时错题本', TODAY);
check('周日+错题', r && r.minutes === 180 && r.day_token === 'weekday:6', `got ${JSON.stringify(r)}`);

/* ---------------- 计划工具 ---------------- */
console.log('== planner ==');

const PLAN = {
  examDate: '2026-12-26',
  template: { '1': [{ start: '08:30', end: '11:30', subject: '数学' }] },
  days: { '2026-10-31': { slots: [
    { start: '08:00', end: '11:00', subject: '数学', topic: '真题卷' },
    { start: '14:00', end: '16:30', subject: '数据结构', topic: '王道第3章' }
  ], note: '冲刺周' } }
};

let p = day_plan(PLAN, TODAY);
check('days 优先', p.slots.length === 2 && p.note === '冲刺周');
const MONDAY = '2026-11-02';   // 周一
p = day_plan(PLAN, MONDAY);
check('template 兜底', p.slots.length === 1 && p.note === '');
p = day_plan(PLAN, '2026-11-03');   // 周二无模板
check('无计划 -> 空', p.slots.length === 0);

check('planned_minutes', planned_minutes(PLAN.template['1']) === 180
  && planned_minutes(PLAN.days['2026-10-31'].slots) === 330);
check('fmt_minutes', fmt_minutes(150) === '2小时30分钟' && fmt_minutes(45) === '45分钟');
check('countdown', countdown_text(PLAN, TODAY).includes('56'), countdown_text(PLAN, TODAY));

const text = render_day(TODAY, PLAN.days['2026-10-31'].slots, '冲刺周');
check('render_day', text.includes('08:00-11:00') && text.includes('真题卷')
  && text.includes('冲刺周') && text.includes('周六'), text);

/* ---------------- 周统计 / 健康分 ---------------- */
console.log('== week_stats / health ==');

const sessions = [];
[300, 240, 0, 180, 360, 0, 200].forEach((mins, i) => {   // 周日~周六
  if (mins) {
    sessions.push({
      id: String(i), date: addDaysLocal(TODAY, -(6 - i)),
      subject: i % 2 ? '数学' : '英语', duration: mins, content: ''
    });
  }
});
function addDaysLocal(ds, n) {
  const t = Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10)) / 86400000 + n;
  return new Date(t * 86400000).toISOString().slice(0, 10);
}

const checkin = {};
for (let i = 0; i < 4; i++) checkin[addDaysLocal(TODAY, -i)] = true;

const stats = week_stats(sessions, checkin, PLAN, TODAY, 2940);
check('总时长', stats.total_minutes === [300, 240, 180, 360, 200].reduce((a, b) => a + b, 0), stats.total_minutes);
check('学习天数', stats.active_days === 5, stats.active_days);
check('科目分布', (stats.by_subject['数学'] || 0) + (stats.by_subject['英语'] || 0) === stats.total_minutes);

const h = health_score(stats, ['好', '一般', '糟']);
check('健康分范围', h.score >= 0 && h.score <= 100 && !!h.label, JSON.stringify(h));
const h2 = health_score({ ...stats, total_minutes: 0, active_days: 0, streak: 0, adherence: 0 }, []);
check('全零低分', h2.score < 40, JSON.stringify(h2));

console.log('');
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} 个用例失败：${FAILS.join('、')}`);
  process.exit(1);
}
console.log('✅ 全部通过');
