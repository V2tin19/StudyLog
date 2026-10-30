"""test_core.py —— nlu / planner 的本地断言测试（不依赖 aiohttp，python test_core.py 直接跑）

覆盖用户红线：日期归属必须正确（当天的记到当天）。
"""

from datetime import date, timedelta

import nlu
import planner

FAILS = []


def check(name, cond, detail=''):
    if cond:
        print(f'  ok  {name}')
    else:
        FAILS.append(name)
        print(f'FAIL  {name}  {detail}')


TODAY = date(2026, 10, 31)          # 周六（weekday()=5）
WED = date(2026, 10, 28)            # 周三


# ---------------- 日期标记解析 ----------------
print('== resolve_day_token ==')
d, lab = nlu.resolve_day_token(None, TODAY)
check('None -> 今天', d == TODAY)
d, lab = nlu.resolve_day_token('yesterday', TODAY)
check('yesterday -> 昨天', d == date(2026, 10, 30) and lab == '昨天')
d, lab = nlu.resolve_day_token('before_yesterday', TODAY)
check('before_yesterday -> 前天', d == date(2026, 10, 29))
d, lab = nlu.resolve_day_token('day_offset:-3', TODAY)
check('大前天', d == date(2026, 10, 28))
# 今天是周六，说「周四学的」→ 最近过去的周四 = 2 天前
d, lab = nlu.resolve_day_token('weekday:3', TODAY)
check('周六说周四 -> 两天前', d == date(2026, 10, 29), f'got {d}')
# 今天是周三，说「周四学的」→ 上周四（未来不可记）
d, lab = nlu.resolve_day_token('weekday:3', WED)
check('周三说周四 -> 上周四', d == date(2026, 10, 22), f'got {d}')
# 今天周六说「周六学的」→ 就是今天
d, lab = nlu.resolve_day_token('weekday:5', TODAY)
check('周六说周六 -> 今天', d == TODAY)
# 明确日期（过去）
d, lab = nlu.resolve_day_token('2026-10-15', TODAY)
check('明确过去日期', d == date(2026, 10, 15))
# 明确日期（未来）→ 拒绝（带年份的明确未来日期，绝不滚去年）
d, lab = nlu.resolve_day_token('2026-12-26', TODAY)
check('未来日期拒绝', d is None, f'got {d} {lab}')
d, lab = nlu.resolve_day_token('2027-10-31', TODAY)
check('远未来日期拒绝', d is None, f'got {d} {lab}')
# 不存在的日期
d, lab = nlu.resolve_day_token('2026-02-30', TODAY)
check('不存在日期拒绝', d is None)
# 超过一年
d, lab = nlu.resolve_day_token('2025-01-01', TODAY)
check('超过一年拒绝', d is None)


# ---------------- 中文数字 ----------------
print('== cn2num ==')
check('两', nlu.cn2num('两') == 2)
check('俩', nlu.cn2num('俩') == 2)
check('十五', nlu.cn2num('十五') == 15)
check('二十', nlu.cn2num('二十') == 20)
check('1.5', nlu.cn2num('1.5') == 1.5)
check('乱码', nlu.cn2num('abc') is None)


# ---------------- 日期词抽取 ----------------
print('== extract_day_token ==')
tok, rest = nlu.extract_day_token('今天下午学了2小时数据结构')
check('今天', tok == 'today' and '今天' not in rest)
tok, rest = nlu.extract_day_token('昨天晚上背了1小时单词')
check('昨晚 -> yesterday', tok == 'yesterday')
tok, rest = nlu.extract_day_token('周三学了高数')
check('周三 -> weekday:2', tok == 'weekday:2', f'got {tok}')
tok, rest = nlu.extract_day_token('10月28号刷了题')
check('10月28号 -> 过去日期', tok == '2026-10-28', f'got {tok}')
tok, rest = nlu.extract_day_token('3月1号学的')
check('今年3月1号(过去)', tok == '2026-03-01', f'got {tok}')
tok, rest = nlu.extract_day_token('12月26号学的')
check('12月26号(未来) -> 去年', tok == '2025-12-26', f'got {tok}')


# ---------------- 学习记录快车道 ----------------
print('== try_parse_log ==')

r = nlu.try_parse_log('今天下午学了2小时数据结构，刷了王道课后题')
check('常规句', r and r['subject'] == '数据结构' and r['minutes'] == 120
      and r['day_token'] == 'today' and '王道' in (r['content'] or ''), f'got {r}')

r = nlu.try_parse_log('昨天晚上背了1小时单词')
check('昨天+单词', r and r['subject'] == '英语' and r['minutes'] == 60
      and r['day_token'] == 'yesterday', f'got {r}')

r = nlu.try_parse_log('学了俩小时')
check('无科目但有学', r and r['minutes'] == 120 and r['subject'] == '其他', f'got {r}')

r = nlu.try_parse_log('刷了半小时408真题')
check('半小时+408', r and r['minutes'] == 30 and r['subject'] == '408', f'got {r}')

r = nlu.try_parse_log('昨晚复习了1.5小时高数')
check('1.5小时+高数', r and r['minutes'] == 90 and r['subject'] == '数学'
      and r['day_token'] == 'yesterday', f'got {r}')

r = nlu.try_parse_log('一个半小时线代')
check('一个半小时', r and r['minutes'] == 90 and r['subject'] == '数学', f'got {r}')

r = nlu.try_parse_log('90分钟操作系统')
check('90分钟', r and r['minutes'] == 90 and r['subject'] == '操作系统', f'got {r}')

r = nlu.try_parse_log('看了2小时网课')
check('看了2小时网课', r and r['minutes'] == 120 and r['subject'] == '其他', f'got {r}')

r = nlu.try_parse_log('玩了2小时手机')
check('玩手机的拦截', r is None, f'got {r}')

r = nlu.try_parse_log('今天心情不错')
check('无时长不误记', r is None, f'got {r}')

r = nlu.try_parse_log('状态不好，帮我把计划松一点')
check('状态反馈不误记', r is None, f'got {r}')

r = nlu.try_parse_log('周日整理了3小时错题本')
check('周日+错题', r and r['minutes'] == 180 and r['day_token'] == 'weekday:6', f'got {r}')


# ---------------- 计划工具 ----------------
print('== planner ==')

PLAN = {
    'examDate': '2026-12-26',
    'template': {'1': [{'start': '08:30', 'end': '11:30', 'subject': '数学'}]},
    'days': {'2026-10-31': {'slots': [
        {'start': '08:00', 'end': '11:00', 'subject': '数学', 'topic': '真题卷'},
        {'start': '14:00', 'end': '16:30', 'subject': '数据结构', 'topic': '王道第3章'},
    ], 'note': '冲刺周'}},
}

slots, note = planner.day_plan(PLAN, TODAY)
check('days 优先', len(slots) == 2 and note == '冲刺周')
monday = date(2026, 11, 2)  # 周一
slots, note = planner.day_plan(PLAN, monday)
check('template 兜底', len(slots) == 1 and note == '')
slots, _ = planner.day_plan(PLAN, date(2026, 11, 3))  # 周二无模板
check('无计划 -> 空', slots == [])

check('planned_minutes', planner.planned_minutes(PLAN['template']['1']) == 180
      and planner.planned_minutes(PLAN['days']['2026-10-31']['slots']) == 330)
check('fmt_minutes', planner.fmt_minutes(150) == '2小时30分钟' and planner.fmt_minutes(45) == '45分钟')
check('countdown', '56' in planner.countdown_text(PLAN, TODAY), planner.countdown_text(PLAN, TODAY))

text = planner.render_day(TODAY, PLAN['days']['2026-10-31']['slots'], '冲刺周')
check('render_day', '08:00-11:00' in text and '真题卷' in text and '冲刺周' in text and '周六' in text, text)


# ---------------- 周统计 / 健康分 ----------------
print('== week_stats / health ==')

sessions = []
for i, mins in enumerate([300, 240, 0, 180, 360, 0, 200]):   # 周日~周六
    d = TODAY - timedelta(days=6 - i)
    if mins:
        sessions.append({'id': str(i), 'date': d.isoformat(), 'subject': '数学' if i % 2 else '英语',
                         'duration': mins, 'content': ''})

stats = planner.week_stats(sessions, {d.isoformat(): True for d in
                                      [TODAY - timedelta(days=i) for i in range(4)]},
                           PLAN, TODAY, weekly_target_minutes=2940)
check('总时长', stats['total_minutes'] == sum([300, 240, 180, 360, 200]), stats['total_minutes'])
check('学习天数', stats['active_days'] == 5, stats['active_days'])
check('科目分布', stats['by_subject'].get('数学', 0) + stats['by_subject'].get('英语', 0) == stats['total_minutes'])

h = planner.health_score(stats, ['好', '一般', '糟'])
check('健康分范围', 0 <= h['score'] <= 100 and h['label'], h)
h2 = planner.health_score({**stats, 'total_minutes': 0, 'active_days': 0, 'streak': 0, 'adherence': 0}, [])
check('全零低分', h2['score'] < 40, h2)

print()
if FAILS:
    print(f'❌ {len(FAILS)} 个用例失败：{FAILS}')
    raise SystemExit(1)
print('✅ 全部通过')
