"""planner.py —— 计划数据模型的纯函数工具 + 统计 + 健康分

计划 JSON 的结构（与 functions/api/admin/kaoyan-plan.js 的校验一致）：
  plan.examDate: "YYYY-MM-DD"
  plan.template: {"0"~"6": [slot...]}          每周模板（"0"=周日）
  plan.days:     {"YYYY-MM-DD": {"slots":[...], "note": ""}}   覆盖模板

这里所有函数都是纯的（给 llm/handlers/main 共用，也方便单测）。
"""

import re
from datetime import date, datetime, timedelta

WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

SUBJECTS_408 = ['数学', '英语', '政治', '数据结构', '操作系统',
                '计算机组成原理', '计算机网络']


# ---------------------------------------------------------------
# 计划读取 / 渲染
# ---------------------------------------------------------------

def template_key(d: date) -> str:
    """date → 模板键 '0'~'6'（'0' 是周日，与网页端 Extras 一致）"""
    return str((d.weekday() + 1) % 7)


def day_plan(plan: dict, d: date):
    """某天的计划：days 优先，落到 template，都没有返回 ([], '')"""
    plan = plan or {}
    day = (plan.get('days') or {}).get(d.isoformat())
    if day and isinstance(day, dict):
        return list(day.get('slots') or []), str(day.get('note') or '')
    tpl = (plan.get('template') or {}).get(template_key(d))
    if tpl and isinstance(tpl, list):
        return list(tpl), ''
    return [], ''


def planned_minutes(slots) -> int:
    """计划时段的总分钟数（休息也计入，它占的是日历时间）"""
    total = 0
    for s in slots or []:
        if isinstance(s, dict) and re.match(r'^\d{1,2}:\d{2}$', str(s.get('start', ''))) \
                and re.match(r'^\d{1,2}:\d{2}$', str(s.get('end', ''))):
            sh, sm = map(int, str(s['start']).split(':'))
            eh, em = map(int, str(s['end']).split(':'))
            mins = (eh * 60 + em) - (sh * 60 + sm)
            if mins > 0:
                total += mins
    return total


def fmt_minutes(m: int) -> str:
    h, mm = divmod(int(m), 60)
    return f'{h}小时{mm}分钟' if h else f'{mm}分钟'


def render_day(d: date, slots, note: str = '', include_status: bool = False) -> str:
    """把一天的计划渲染成 QQ 消息文本。include_status 时用当前时间标「现在/已过」。"""
    lines = [f'📌 {d.isoformat()} {WEEKDAY_CN[d.weekday()]}']
    if not slots:
        lines.append('（这天还没有安排）')
        if note:
            lines.append(f'备注：{note}')
        return '\n'.join(lines)

    now_hhmm = datetime.now().strftime('%H:%M') if include_status else None
    for s in slots:
        if not isinstance(s, dict):
            continue
        mark = ''
        if now_hhmm:
            if str(s.get('end', '')) <= now_hhmm:
                mark = ' ✅'
            elif str(s.get('start', '')) <= now_hhmm:
                mark = ' 🔔'
        topic = f'｜{s["topic"]}' if s.get('topic') else ''
        dur = ''
        if re.match(r'^\d{1,2}:\d{2}$', str(s.get('start', ''))) and re.match(r'^\d{1,2}:\d{2}$', str(s.get('end', ''))):
            dur = f'（{fmt_minutes(planned_minutes([s]))}）'
        lines.append(f'{s.get("start", "??:??")}-{s.get("end", "??:??")}{dur} {s.get("subject", "?")}{topic}{mark}')
    if note:
        lines.append(f'📝 {note}')
    return '\n'.join(lines)


def countdown_text(plan: dict, today: date):
    """考试倒计时文案；没设考试日期返回 None"""
    exam = (plan or {}).get('examDate')
    if not exam or not re.match(r'^\d{4}-\d{2}-\d{2}$', str(exam)):
        return None
    try:
        d = date.fromisoformat(str(exam))
    except ValueError:
        return None
    diff = (d - today).days
    if diff < 0:
        return '考试已经结束，祝上岸顺利 🎉'
    if diff == 0:
        return '🎯 今天就是考试日，稳住，你能行！'
    return f'⏳ 距离初试（{exam}）还有 {diff} 天'


# ---------------------------------------------------------------
# 统计（周报 & 健康分的数据都在这算，LLM 只负责说话）
# ---------------------------------------------------------------

def week_window(today: date, days: int = 7):
    """最近 days 天（含今天）的日期列表与边界"""
    dates = [today - timedelta(days=i) for i in range(days - 1, -1, -1)]
    return dates, dates[0].isoformat(), dates[-1].isoformat()


def week_stats(sessions: list, checkin: dict, plan: dict, today: date,
               weekly_target_minutes: int = 2940):
    """最近 7 天的统计。sessions 是云端返回的记录列表（可能带任意字段）。"""
    dates, start, end = week_window(today)
    date_set = {d.isoformat() for d in dates}

    by_day = {d.isoformat(): 0 for d in dates}
    by_subject = {}
    for s in sessions or []:
        if not isinstance(s, dict):
            continue
        d = str(s.get('date') or '')
        if d not in date_set:
            continue
        mins = s.get('duration') or s.get('minutes') or 0
        try:
            mins = int(mins)
        except (TypeError, ValueError):
            continue
        by_day[d] += mins
        subj = str(s.get('subject') or '其他')
        by_subject[subj] = by_subject.get(subj, 0) + mins

    active_days = sum(1 for v in by_day.values() if v > 0)
    total = sum(by_day.values())

    # 连续学习天数（今天或昨天截止）
    streak = 0
    cur = today if by_day.get(today.isoformat(), 0) > 0 else today - timedelta(days=1)
    while by_day.get(cur.isoformat(), 0) > 0:
        streak += 1
        cur -= timedelta(days=1)

    # 计划符合度：只统计「那天有计划」的日子（min(实际/计划, 1) 的平均）
    adherences = []
    for d in dates:
        slots, _ = day_plan(plan, d)
        planned = planned_minutes([s for s in slots if isinstance(s, dict)
                                   and str(s.get('subject')) not in ('休息', '锻炼')])
        if planned > 0:
            adherences.append(min(by_day[d.isoformat()] / planned, 1.0))
    adherence = sum(adherences) / len(adherences) if adherences else None

    checkin_days = sum(1 for d in dates if (checkin or {}).get(d.isoformat()))

    return {
        'start': start, 'end': end,
        'by_day': {d.isoformat(): by_day[d.isoformat()] for d in dates},
        'by_subject': dict(sorted(by_subject.items(), key=lambda kv: -kv[1])),
        'total_minutes': total,
        'active_days': active_days,
        'streak': streak,
        'checkin_days': checkin_days,
        'adherence': round(adherence, 2) if adherence is not None else None,
        'daily_avg_minutes': round(total / 7),
        'weekly_target_minutes': weekly_target_minutes,
    }


def health_score(stats: dict, moods: list):
    """健康分 0~100。

    构成：时长达成 30 + 出勤 25 + 计划符合 20 + 连续性 15 + 心态 10
    moods: 最近 7 天日记的 mood 字符串列表（好/一般/糟 一类的词）
    """
    target = stats.get('weekly_target_minutes') or 2940
    s_time = min(stats['total_minutes'] / max(target, 1), 1.0) * 30
    s_days = stats['active_days'] / 7 * 25
    s_adh = (stats['adherence'] if stats.get('adherence') is not None else 0.5) * 20
    s_streak = min(stats['streak'], 7) / 7 * 15

    POS = ('好', '棒', '开心', '不错', '很好', '充实', '满')
    MID = ('一般', '还行', '普通', '平平')
    score_vals = []
    for m in moods:
        m = str(m or '')
        if not m:
            continue
        if any(p in m for p in POS):
            score_vals.append(2.0)
        elif any(p in m for p in MID):
            score_vals.append(1.0)
        else:
            score_vals.append(0.0)
    mood_avg = sum(score_vals) / len(score_vals) if score_vals else None
    s_mood = (mood_avg / 2 * 10) if mood_avg is not None else 5.0

    total = round(s_time + s_days + s_adh + s_streak + s_mood)
    if total >= 85:
        label = '满血 🔥'
    elif total >= 70:
        label = '良好 💪'
    elif total >= 55:
        label = '一般 😐'
    elif total >= 40:
        label = '疲劳 ⚠️'
    else:
        label = '需要休息 🩺'

    return {
        'score': total,
        'label': label,
        'breakdown': {
            '时长达成': round(s_time), '出勤': round(s_days),
            '计划符合': round(s_adh), '连续性': round(s_streak),
            '心态': round(s_mood, 1),
        },
        'mood_avg': round(mood_avg, 2) if mood_avg is not None else None,
    }
