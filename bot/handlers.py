"""handlers.py —— 消息意图路由 + 各功能的实际处理

意图识别用「关键词优先，LLM 兜底」：
  高频明确的指令（帮助/打卡/撤销/查安排/总结）直接正则命中，零 LLM 开销；
  学习录入先走 nlu 正则快车道，认不出再问 LLM；
  都不是的才进闲聊。

铁律再重复一遍：所有日期都由 nlu.resolve_day_token 在代码里解析，
LLM 只产出 day 标记。这里负责把标记解析成日期并做最终校验（不许未来、不许超一年）。
"""

import logging
import re
from collections import deque
from datetime import date, datetime, timedelta

import nlu
import planner
from llm import LLMError

log = logging.getLogger('handlers')

PLAN_CACHE_TTL = 60          # 秒，查计划别每条消息都打 CF
HELP_TEXT = (
    '📖 我能帮你做这些（直接说人话就行）：\n'
    '· 记学习：「今天下午学了2小时数据结构，刷了王道课后题」\n'
    '· 查安排：「今天安排」「现在该学什么」「明天计划」\n'
    '· 调状态：「今天状态不好」「明天有事，帮我把计划松一点」\n'
    '· 排计划：「重排本周计划」\n'
    '· 周总结：「本周总结」\n'
    '· 打卡 / 撤销：「打卡」「撤销刚才那条」\n'
    '· 设考试日期：「考试日期 2026-12-26」'
)

FEEDBACK_RE = re.compile(
    r'状态不好|没状态|不在状态|太累|好累|累了|疲惫|疲|生病|感冒|发烧|头疼|不舒服|'
    r'不想学|学不进|学不动|效率低|没效率|emo|丧|烦|焦虑|崩了|失眠|熬夜了|'
    r'有事|太忙|加班|要出门|出门|面试|考试周|心情不好|状态差'
)
QUERY_RE = re.compile(r'(安排|计划|日程|学什么|学点啥|学啥|干嘛|干什么)')
REGEN_RE = re.compile(r'重排|重新生成|重新安排|重新排|排一下|帮我排|生成.{0,4}计划|更新计划|再来一份计划')
REPORT_RE = re.compile(r'总结|周报|复盘|汇报')
STATS_RE = re.compile(r'(今天|本周|这周|最近).{0,6}(学了|学了多久|学了多少|时长|多久)')
UNDO_RE = re.compile(r'撤销|记错了|删掉刚才|撤回')
CHECKIN_RE = re.compile(r'^打卡$|^打卡了|^补打卡|打个卡')
EXAM_DATE_RE = re.compile(r'(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})')
HELP_RE = re.compile(r'^帮助$|^菜单$|^功能|^help|^你能干|怎么用|^指令')


class Handlers:
    def __init__(self, cfg: dict, cf, llm):
        self.cfg = cfg
        self.cf = cf
        self.llm = llm
        self._recent = {}                      # user_id -> deque[(session_id, 描述)]
        self._plan_cache = (0.0, None)         # (monotonic, plan)

    # ---------------- 公共小工具 ----------------

    def now(self) -> datetime:
        from zoneinfo import ZoneInfo
        tzname = (self.cfg.get('timezone') or 'Asia/Shanghai')
        try:
            return datetime.now(ZoneInfo(tzname))
        except Exception:
            return datetime.now(timedelta(hours=8))   # 认不出的时区按北京时间

    def now_desc(self) -> str:
        n = self.now()
        return n.strftime('%Y-%m-%d %H:%M') + ' ' + planner.WEEKDAY_CN[n.weekday()]

    def target_minutes(self) -> int:
        return int(self.cfg.get('study', {}).get('weekly_target_hours', 49) * 60)

    async def get_plan(self, force=False):
        import time
        ts, cached = self._plan_cache
        now = time.monotonic()
        if not force and cached is not None and now - ts < PLAN_CACHE_TTL:
            return cached
        plan, _, _ = await self.cf.get_plan()
        self._plan_cache = (now, plan)
        return plan

    def invalidate_plan(self):
        self._plan_cache = (0.0, None)

    # ---------------- 入口 ----------------

    async def handle(self, text: str, user_id: int) -> str:
        text = (text or '').strip()
        if not text:
            return ''

        try:
            return await self._route(text, user_id)
        except LLMError as e:
            log.warning('LLM 出错：%s', e)
            return f'⚠️ AI 出了点问题：{e}\n可以稍后再试，或先用「帮助」看手动指令。'
        except Exception as e:
            log.exception('处理消息出错')
            return f'⚠️ 出错了：{e}'

    async def _route(self, text: str, user_id: int) -> str:
        # ---- 1. 帮助 ----
        if HELP_RE.search(text):
            return HELP_TEXT

        # ---- 2. 撤销 ----
        if UNDO_RE.search(text):
            return await self._undo(user_id)

        # ---- 3. 打卡 ----
        if CHECKIN_RE.search(text):
            return await self._checkin()

        # ---- 4. 设置考试日期 ----
        if '考试' in text and ('日期' in text or '时间' in text or '倒计时' in text):
            m = EXAM_DATE_RE.search(text)
            if m:
                return await self._set_exam_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            plan = await self.get_plan()
            cd = planner.countdown_text(plan, self.now().date())
            return cd or '还没设置考试日期。发「考试日期 2026-12-26」来设置。'

        # ---- 5. 重排本周 ----
        if REGEN_RE.search(text) or ('计划' in text and '生成' in text):
            return await self._regen_week(text)

        # ---- 6. 状态反馈 → 重排当天/明天 ----
        if FEEDBACK_RE.search(text):
            return await self._adjust_day(text)

        # ---- 7. 查统计 ----
        if STATS_RE.search(text):
            return await self._stats(text)

        # ---- 8. 周报 ----
        if REPORT_RE.search(text):
            return await self._weekly_report()

        # ---- 9. 查计划 ----
        if QUERY_RE.search(text):
            return await self._query_plan(text)

        # ---- 10. 学习记录：正则快车道 ----
        parsed = nlu.try_parse_log(text)
        if parsed:
            return await self._record(user_id, [parsed])

        # ---- 11. 学习记录：LLM 兜底 ----
        sessions = await self.llm.extract_sessions(text, self.now_desc())
        if sessions:
            return await self._record(user_id, sessions)

        # ---- 12. 闲聊兜底 ----
        try:
            plan = await self.get_plan()
            ctx = f'考试倒计时：{planner.countdown_text(plan, self.now().date()) or "未设置"}'
        except Exception:
            ctx = ''
        return await self.llm.chat_reply(text, ctx)

    # ================= 学习记录 =================

    async def _record(self, user_id: int, items: list) -> str:
        today = self.now().date()
        payload = []
        labels = []
        for it in items:
            d, label = nlu.resolve_day_token(it.get('day_token'), today)
            if d is None:
                return f'⚠️ 日期没解析对：{label}，这条先没记。'
            if d > today:
                return f'⚠️「{label}」是未来的日期，学习记录不能记未来哦。'
            payload.append({
                'subject': it['subject'],
                'duration': it['minutes'],
                'content': it.get('content') or '',
                'date': d.isoformat(),
            })
            label_cn = ('今天' if d == today else
                        '昨天' if d == today - timedelta(days=1) else
                        d.strftime('%m-%d') + ' ' + planner.WEEKDAY_CN[d.weekday()])
            labels.append((label_cn, it['subject'], it['minutes'], it.get('content') or ''))

        saved = await self.cf.add_sessions(payload)

        # 登记到撤销栈（「撤销」按条删，详见 _undo）
        stack = self._recent.setdefault(user_id, deque(maxlen=10))
        for s in saved:
            stack.append((s.get('id'),
                          f"{s.get('date')} {s.get('subject')} {planner.fmt_minutes(s.get('duration') or 0)}"))

        return self._confirm(labels, saved)

    def _confirm(self, labels, saved) -> str:
        lines = []
        for (label_cn, subject, minutes, content) in labels:
            line = f'✅ {label_cn} · {subject} · {planner.fmt_minutes(minutes)}'
            if content:
                line += f'\n   └ {content}'
            lines.append(line)
        total = sum(m for (_, _, m, _) in labels)
        tail = f'\n共 {len(labels)} 条，合计 {planner.fmt_minutes(total)}'
        if len(saved) != len(labels):
            tail += '\n（注意：部分记录可能没写进去）'
        return '\n'.join(lines) + tail

    async def _undo(self, user_id: int) -> str:
        stack = self._recent.get(user_id)
        if not stack:
            return '这个会话里还没有可撤销的记录（只能撤销本次 bot 运行期间记录的）。'
        sid, desc = stack.pop()
        try:
            await self.cf.delete_session(str(sid))
        except Exception as e:
            return f'⚠️ 撤销失败：{e}'
        return f'↩️ 已撤销：{desc}'

    # ================= 打卡 / 统计 =================

    async def _checkin(self) -> str:
        today = self.now().date().isoformat()
        await self.cf.checkin(today)
        _, checkin = await self.cf.get_sessions(days=1)
        dates = sorted(d for d, v in (checkin or {}).items() if v)
        streak = 0
        cur = self.now().date()
        while cur.isoformat() in dates:
            streak += 1
            cur -= timedelta(days=1)
        return f'✅ 已打卡（{today}），连续 {streak} 天 🔥'

    async def _stats(self, text: str) -> str:
        sessions, checkin = await self.cf.get_sessions(days=8)
        today = self.now().date()
        stats = planner.week_stats(sessions, checkin, await self.get_plan(), today, self.target_minutes())
        if '今天' in text:
            m = stats['by_day'].get(today.isoformat(), 0)
            return f'今天学了 {planner.fmt_minutes(m)}' + ('，还没打卡（发「打卡」）' if not (checkin or {}).get(today.isoformat()) else '，已打卡 ✅')
        lines = [f'📊 最近 7 天（{stats["start"]} ~ {stats["end"]}）',
                 f'总计 {planner.fmt_minutes(stats["total_minutes"])}，日均 {planner.fmt_minutes(stats["daily_avg_minutes"])}',
                 f'学习 {stats["active_days"]}/7 天，连续 {stats["streak"]} 天']
        if stats['by_subject']:
            lines.append('科目分布：' + '，'.join(
                f'{k} {planner.fmt_minutes(v)}' for k, v in list(stats['by_subject'].items())[:6]))
        return '\n'.join(lines)

    # ================= 查计划 =================

    async def _query_plan(self, text: str) -> str:
        today = self.now().date()
        plan = await self.get_plan()
        cd = planner.countdown_text(plan, today)

        target = today
        if re.search(r'明天', text):
            target = today + timedelta(days=1)
        elif re.search(r'后天', text):
            target = today + timedelta(days=2)
        elif re.search(r'昨天', text):
            target = today - timedelta(days=1)

        slots, note = planner.day_plan(plan, target)
        body = planner.render_day(target, slots, note, include_status=(target == today))
        return (cd + '\n\n' + body) if cd else body

    # ================= 状态反馈重排 =================

    async def _adjust_day(self, text: str) -> str:
        today = self.now().date()
        target = today + timedelta(days=1) if re.search(r'明天', text) else today
        plan = await self.get_plan()

        slots, note = planner.day_plan(plan, target)
        if not slots:
            what = '今天' if target == today else '明天'
            return f'{what}还没有安排。可以先发「重排本周计划」生成一份，再按状态调整。'

        plan_day = {'slots': slots, 'note': note}
        result = await self.llm.adjust_day(plan_day, text, self.now_desc(),
                                           planner.WEEKDAY_CN[target.weekday()])
        new_slots = result.get('slots')
        if not isinstance(new_slots, list) or not new_slots:
            return '⚠️ AI 没给出新安排，再试一次或换个说法。'

        # 本地校验（和服务端 kaoyan-plan.js 同一套规则），坏计划不上送
        err = self._validate_slots(new_slots)
        if err:
            return f'⚠️ AI 生成的计划有问题（{err}），没有写入。再试一次吧。'

        plan.setdefault('days', {})[target.isoformat()] = {
            'slots': new_slots,
            'note': str(result.get('note') or '')[:200],
        }
        await self.cf.put_plan(plan)
        self.invalidate_plan()

        # 只展示还没过去的时段，过去的保留原样没意义
        now_hhmm = self.now().strftime('%H:%M') if target == today else None
        upcoming = [s for s in new_slots
                    if not (target == today and str(s.get('end', '99:99')) <= now_hhmm)]
        head = '🛠 已按你的状态调整（原计划降量，砍掉的时段换成了休息）：\n'
        if not upcoming:
            return head + '\n今天剩下的时段已经不多，早点休息，明天再战。'
        return head + '\n' + planner.render_day(target, upcoming, result.get('note') or '')

    @staticmethod
    def _validate_slots(slots) -> str:
        """返回错误文案或 ''。规则与 kaoyan-plan.js 保持一致。"""
        if not isinstance(slots, list) or not slots:
            return '时段为空'
        parsed = []
        for i, s in enumerate(slots):
            if not isinstance(s, dict):
                return f'第{i + 1}项不是对象'
            st, en = str(s.get('start', '')), str(s.get('end', ''))
            if not re.match(r'^([01]\d|2[0-3]):[0-5]\d$', st):
                return f'第{i + 1}项开始时间 {st} 不合法'
            if not re.match(r'^([01]\d|2[0-3]):[0-5]\d$', en):
                return f'第{i + 1}项结束时间 {en} 不合法'
            sh, sm = map(int, st.split(':'))
            eh, em = map(int, en.split(':'))
            if (eh * 60 + em) <= (sh * 60 + sm):
                return f'第{i + 1}项结束要晚于开始'
            if not str(s.get('subject', '')).strip():
                return f'第{i + 1}项缺科目'
            parsed.append((sh * 60 + sm, eh * 60 + em))
        parsed.sort()
        for a, b in zip(parsed, parsed[1:]):
            if b[0] < a[1]:
                return f'时段 {b[0] // 60:02d}:{b[0] % 60:02d} 与上一段重叠'
        return ''

    # ================= 重排本周 =================

    async def _regen_week(self, text: str) -> str:
        today = self.now().date()
        plan = await self.get_plan()
        sessions, checkin = await self.cf.get_sessions(days=8)
        stats = planner.week_stats(sessions, checkin, plan, today, self.target_minutes())

        week_dates = [today + timedelta(days=i) for i in range(1, 8)]
        context = {
            '今天': self.now_desc(),
            '考试倒计时': planner.countdown_text(plan, today) or '未设置考试日期',
            '考试日期': plan.get('examDate') or '',
            '未来7天日期列表': [d.isoformat() for d in week_dates],
            '未来7天星期': [planner.WEEKDAY_CN[d.weekday()] for d in week_dates],
            '最近7天各科目时长': stats['by_subject'],
            '最近7天总时长': planner.fmt_minutes(stats['total_minutes']),
            '最近7天学习天数': f'{stats["active_days"]}/7',
            '每周目标小时': self.target_minutes() // 60,
            '用户附加要求': text,
        }
        result = await self.llm.gen_week(context)

        days = result.get('days')
        if not isinstance(days, dict) or not days:
            return '⚠️ AI 没生成出计划，再试一次。'

        want = {d.isoformat() for d in week_dates}
        got = set(days.keys())
        if got != want:
            return f'⚠️ AI 生成的日期对不上（期望 {sorted(want)[:3]}…），没有写入。再试一次。'

        for dstr, day in days.items():
            err = self._validate_slots(day.get('slots') if isinstance(day, dict) else None)
            if err:
                return f'⚠️ AI 生成的 {dstr} 计划有问题（{err}），没有写入。再试一次。'

        plan.setdefault('days', {}).update(
            {d: {'slots': day.get('slots', []), 'note': str(day.get('note') or '')[:200]}
             for d, day in days.items()})
        if isinstance(result.get('template'), dict):
            plan['template'] = result['template']
        if result.get('summary'):
            plan['lastSummary'] = str(result['summary'])[:200]
        await self.cf.put_plan(plan)
        self.invalidate_plan()

        out = ['🗓 已生成未来 7 天计划']
        if result.get('summary'):
            out.append(str(result['summary']))
        out.append('')
        out.append('▼ 明天（今天剩余安排不变）')
        tomorrow = today + timedelta(days=1)
        slots, note = planner.day_plan(plan, tomorrow)
        out.append(planner.render_day(tomorrow, slots, note))
        out.append('')
        out.append('发「今天安排」看今天完整版。')
        return '\n'.join(out)

    # ================= 周报 =================

    async def weekly_report_text(self) -> str:
        today = self.now().date()
        sessions, checkin = await self.cf.get_sessions(days=8)
        plan = await self.get_plan()
        stats = planner.week_stats(sessions, checkin, plan, today, self.target_minutes())

        moods = []
        try:
            entries = await self.cf.get_diary(limit=14)
            window = {d.isoformat() for d in planner.week_window(today)[0]}
            moods = [e.get('mood') for e in entries
                     if isinstance(e, dict) and e.get('date') in window and e.get('mood')]
        except Exception as e:
            log.warning('拿日记心情失败（不影响报告主体）：%s', e)

        health = planner.health_score(stats, moods)
        narrative = await self.llm.weekly_report(
            {'统计': stats, '健康分构成': health['breakdown'], '心情均值': health['mood_avg']},
            [{'date': None, 'mood': m} for m in moods][:7],
        )

        lines = ['📊 本周学习报告（' + stats['start'] + ' ~ ' + stats['end'] + '）',
                 f'总分 {health["score"]}/100 {health["label"]}',
                 '构成：' + '，'.join(f'{k} {v}' for k, v in health['breakdown'].items()),
                 '',
                 narrative]
        return '\n'.join(lines)

    async def _weekly_report(self) -> str:
        return await self.weekly_report_text()

    # ================= 设置考试日期 =================

    async def _set_exam_date(self, y: int, m: int, d: int) -> str:
        try:
            exam = date(y, m, d)
        except ValueError:
            return '⚠️ 这个日期不存在，检查一下。'
        plan = await self.get_plan()
        plan['examDate'] = exam.isoformat()
        await self.cf.put_plan(plan)
        self.invalidate_plan()
        diff = (exam - self.now().date()).days
        if diff < 0:
            return f'已设置考试日期 {exam.isoformat()}，不过它已经过了……要更新目标吗？'
        return f'✅ 考试日期已设为 {exam.isoformat()}，距离初试还有 {diff} 天。发「重排本周计划」按倒计时重新规划。'

    # ================= 推送 =================

    async def daily_plan_push(self) -> str:
        today = self.now().date()
        plan = await self.get_plan(force=True)
        slots, note = planner.day_plan(plan, today)
        if not slots:
            return ''
        cd = planner.countdown_text(plan, today)
        yesterday_total = 0
        try:
            sessions, _ = await self.cf.get_sessions(days=2)
            yesterday_total = sum(s.get('duration') or 0 for s in sessions
                                  if s.get('date') == (today - timedelta(days=1)).isoformat())
        except Exception:
            pass
        out = ['☀️ 早安，今天的安排：']
        if yesterday_total:
            out.insert(0, f'昨天学了 {planner.fmt_minutes(yesterday_total)}，保持住 💪')
        if cd:
            out.append(cd)
        out.append(planner.render_day(today, slots, note, include_status=False))
        return '\n'.join(out)

    async def weekly_report_push(self) -> str:
        return await self.weekly_report_text()
