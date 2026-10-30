"""nlu.py —— 日期解析 + 学习记录的正则快车道

设计铁律（改这里之前先读）：
1. 「今天」永远由代码算，LLM 只许输出 day 标记（today/yesterday/周一/YYYY-MM-DD），
   绝不让 LLM 直接产出日期字符串 —— 它会编造。
2. 相对词（今晚/昨天/周三...）一律相对「本地时区的现在」解析，
   解析结果只能是过去或今天（学习记录没有未来）。
3. 正则能搞定的高频句式不进 LLM（快、稳、省 token），
   搞不定的再交给 LLM 抽取，但日期仍然回到代码解析。
"""

import re
from datetime import date, timedelta

# ---------------------------------------------------------------
# 中文数字（够用就好：0~99）
# ---------------------------------------------------------------
_CN_DIGIT = {'零': 0, '一': 1, '二': 2, '两': 2, '俩': 2, '三': 3, '四': 4, '五': 5,
             '六': 6, '七': 7, '八': 8, '九': 9}


def cn2num(s: str):
    """'两'->2, '十五'->15, '1.5'->1.5。认不出返回 None"""
    s = s.strip()
    if not s:
        return None
    if re.fullmatch(r'\d+\.\d+', s):
        return float(s)
    if s.isdigit():
        return int(s)
    if len(s) == 1 and s in _CN_DIGIT:
        return _CN_DIGIT[s]
    if s == '十':
        return 10
    if '十' in s:
        a, _, b = s.partition('十')
        tens = _CN_DIGIT.get(a, 1) if a else 1
        ones = _CN_DIGIT.get(b, 0) if b else 0
        if (a and a not in _CN_DIGIT) or (b and b not in _CN_DIGIT):
            return None
        return tens * 10 + ones
    return None


# ---------------------------------------------------------------
# 日期解析（代码兜底，全项目唯一入口）
# ---------------------------------------------------------------
WEEKDAY_TOKENS = {
    'monday': 0, 'tuesday': 1, 'wednesday': 2, 'thursday': 3,
    'friday': 4, 'saturday': 5, 'sunday': 6,
}

_CN_WEEKDAY = {}
for _tok, _idx in WEEKDAY_TOKENS.items():
    for prefix in ('周', '星期', '礼拜'):
        _name = {0: '一', 1: '二', 2: '三', 3: '四', 4: '五', 5: '六', 6: '日'}[_idx]
        _CN_WEEKDAY[prefix + _name] = _idx
    if _idx == 6:
        _CN_WEEKDAY.update({'周日': 6, '星期天': 6, '礼拜天': 6})

# 文本里出现的日期词 → 偏移天数。长词放前面，防止「昨晚」被「昨」截胡。
_DAY_WORDS = [
    ('大前天', -3), ('昨天', -1), ('昨晚', -1), ('昨夜', -1),
    ('前天', -2), ('今天', 0), ('今日', 0), ('今晚', 0), ('今早', 0),
]
# 只用于从正文里剔除的时间段词（不影响日期归属）
_TIME_OF_DAY = ['凌晨', '大清早', '一大早', '早上', '上午', '中午', '午后',
                '下午', '傍晚', '晚上', '夜里', '深夜', '半夜', '早上好']


def resolve_day_token(token, today: date):
    """day 标记 → 具体日期。

    token 取值：
      None / 'today' / 'yesterday' / 'before_yesterday'
      'day_offset:-3'   （大前天，-1/-2 也有现成标记所以不走这个）
      'YYYY-MM-DD'
      'weekday:N'   （N=0 是周一，对应 python weekday()）
    返回 (date, 标记说明) 或 (None, 错误说明)。
    """
    today = today or date.today()

    if token is None or token == '':
        return today, '今天'
    token = str(token).strip().lower()

    m = re.fullmatch(r'day_offset:(-?\d+)', token)
    if m:
        off = max(-365, min(0, int(m.group(1))))   # 记录没有未来，负数兜底
        d = today + timedelta(days=off)
        return d, f'{abs(off)}天前'

    if token == 'today':
        return today, '今天'
    if token == 'yesterday':
        return today - timedelta(days=1), '昨天'
    if token == 'before_yesterday':
        return today - timedelta(days=2), '前天'

    m = re.fullmatch(r'weekday:([0-6])', token)
    if m:
        target = int(m.group(1))
        # 最近一个过去的该周几（含今天）。今天周三说「周四学的」→ 上周四
        delta = (today.weekday() - target) % 7
        d = today - timedelta(days=delta)
        return d, '周' + '一二三四五六日'[target]

    m = re.fullmatch(r'(\d{4})-(\d{1,2})-(\d{1,2})', token)
    if m:
        try:
            d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None, f'日期不存在：{token}'
        if d > today:
            # 带年份的明确未来日期直接拒绝（不带年份的「12月26号」在
            # extract_day_token 里已经滚回去年了，不会走到这）
            return None, f'{token} 是未来的日期'
        if (today - d).days > 365:
            return None, f'{token} 超过一年前，不让记'
        return d, d.strftime('%m-%d')

    return None, f'认不出这个日期标记：{token}'


def extract_day_token(text: str):
    """从原文里找日期词，返回 (day_token, 剩余文本)。

    返回的 token 是相对标记（给 resolve_day_token 用），正文里把日期词剔掉。
    """
    for word, offset in _DAY_WORDS:
        if word in text:
            if offset == -3:                      # 大前天没有现成英文标记，走偏移标记
                return 'day_offset:-3', text.replace(word, '', 1)
            token = {0: 'today', -1: 'yesterday', -2: 'before_yesterday'}[offset]
            return token, text.replace(word, '', 1)

    m = re.search(r'(\d{1,2})月(\d{1,2})[日号]', text)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        today = date.today()
        try:
            d = date(today.year, month, day)
        except ValueError:
            return None, text
        if (d - today).days > 1:      # 未来 → 多半是去年
            try:
                d = date(today.year - 1, month, day)
            except ValueError:
                return None, text
        return d.isoformat(), text.replace(m.group(0), '', 1)

    for word, idx in _CN_WEEKDAY.items():
        if word in text:
            return f'weekday:{idx}', text.replace(word, '', 1)

    return None, text


# ---------------------------------------------------------------
# 学习记录正则快车道
# ---------------------------------------------------------------
# 科目同义词 → 规范科目名。长的放前面（「计算机网络」要在「网络」之前匹配）
SUBJECT_SYNONYMS = [
    ('数据结构', ['数据结构', '数据结构与算法', 'DS']),
    ('操作系统', ['操作系统', '操统', 'OS']),
    ('计算机组成原理', ['计算机组成原理', '组成原理', '计组']),
    ('计算机网络', ['计算机网络', '计网']),
    ('数学', ['数学', '高数', '高等数学', '线代', '线性代数', '概率论', '概率', '数一', '数二', '数学一', '数学二']),
    ('408', ['408', '专业课']),          # 408 要排在英语前：「408真题」归 408 而不是英语
    ('英语', ['英语', '单词', '阅读', '作文', '长难句', '语法', '真题']),
    ('政治', ['政治', '马原', '肖四', '肖八', '1000题']),
]
# 匹配时按「同义词长度」降序，防止「数据结构」被「数据」抢先 —— 这里没有「数据」，
# 但规矩立好，加短同义词时不踩坑
_ALL_SYNONYMS = sorted(
    ((syn, canon) for canon, syns in SUBJECT_SYNONYMS for syn in syns),
    key=lambda x: -len(x[0])
)

_LEADING_VERBS = ['复习了一遍', '复习了', '复习', '学了一遍', '学了', '学习', '刷了', '刷',
                  '背了', '背', '看了', '看', '做了', '做', '练了', '练', '过了', '过了一遍',
                  '过了一遍', '写了', '写', '整理了', '整理', '过了一轮', '预习了', '预习']


def _match_duration(text: str):
    """从文本里找时长（分钟）和它占用的原文片段。返回 (minutes, span_text) 或 (None, '')"""
    patterns = [
        # 一个半小时 / 1个半小时 / 两小时半 / 半小时（兜底单独列在后面）
        (r'([0-9一二两三四五六七八九十俩]+(?:\.[0-9]+)?)\s*个?\s*半\s*(?:个\s*)?小时', 'half'),
        (r'([0-9一二两三四五六七八九十俩]+(?:\.[0-9]+)?)\s*个?\s*(?:小时|钟头|h|H)', 'hour'),
        (r'半\s*个?\s*小时', 'half30'),
        (r'([0-9一二两三四五六七八九十俩]+)\s*(?:多\s*)?(?:分钟|分|min)(?![钟表])', 'min'),
    ]
    for pat, kind in patterns:
        m = re.search(pat, text)
        if not m:
            continue
        if kind == 'half30':
            return 30, m.group(0)
        num = cn2num(m.group(1))
        if num is None:
            continue
        minutes = int(num * 60) if kind == 'hour' else int(num * 60 + 30) if kind == 'half' else int(num)
        if 1 <= minutes <= 1440:
            return minutes, m.group(0)
    return None, ''


def _match_subject(text: str):
    """找科目。返回 (规范科目名, 原文片段) 或 (None, '')"""
    best = None
    for syn, canon in _ALL_SYNONYMS:
        idx = text.find(syn)
        if idx >= 0 and (best is None or len(syn) > len(best[2])):
            best = (canon, idx, syn)
    if best is None:
        return None, ''
    return best[0], best[2]


def try_parse_log(text: str):
    """正则快车道：一句常见的话 → 一条学习记录。

    返回 dict(subject, minutes, content, day_token) 或 None（认不出就交给 LLM）。
    day_token 同样是相对标记，日期归属由 resolve_day_token 决定。
    """
    if not text:
        return None

    day_token, rest = extract_day_token(text)

    minutes, dur_span = _match_duration(rest)
    if minutes is None:
        return None
    rest = rest.replace(dur_span, ' ', 1)

    subject, sub_span = _match_subject(rest)
    if subject is None:
        # 没提科目但明确说了在学习（「学了俩小时」「整理了3小时错题本」）→ 归「其他」
        if not re.search(r'学|背|刷|练|看|做|复习|整理|错题|笔记|网课|预习|听', rest):
            return None
        subject = '其他'
        sub_span = ''
    rest = rest.replace(sub_span, ' ', 1) if sub_span else rest

    # 二次确认：「其他」必须带学习色彩（防「玩了2小时手机」蒙混过关）
    if subject == '其他' and not re.search(r'学|背|刷|练|复习|做题|错题|笔记|网课|听课|视频课|预习|整理', rest):
        return None

    # 剩下的当内容备注：去时段词、去句首动词、去标点
    for w in _TIME_OF_DAY:
        rest = rest.replace(w, ' ')
    rest = rest.strip(' ，,。.、;；!！?？~的')
    for verb in _LEADING_VERBS:
        if rest.startswith(verb):
            rest = rest[len(verb):]
            break
    rest = rest.strip(' ，,。.、;；!！?？~的了')
    content = re.sub(r'\s{2,}', ' ', rest).strip()
    if len(content) > 200:
        content = content[:200]

    return {
        'subject': subject,
        'minutes': minutes,
        'content': content,
        'day_token': day_token,
    }
