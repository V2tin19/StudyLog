/**
 * _nlu.js —— 日期解析 + 学习记录的正则快车道
 * （自 kaoyan bot 的 nlu.py 逐函数移植，47 条测试用例在 tests/agent/_nlu.test.mjs）
 *
 * 设计铁律（改这里之前先读）：
 * 1. 「今天」永远由代码算，LLM 只许输出 day 标记（today/yesterday/weekday:N/...），
 *    绝不让 LLM 直接产出日期字符串 —— 它会编造。
 * 2. 相对词（今晚/昨天/周三...）一律相对「北京时区的今天」解析，
 *    解析结果只能是过去或今天（学习记录没有未来）。
 * 3. 正则能搞定的高频句式不进 LLM（快、稳、省 token），
 *    搞不定的再交给 LLM 抽取，但日期仍然回到代码解析。
 *
 * 日期一律用 'YYYY-MM-DD' 字符串表示（与 doc 存储一致），内部用「天序号」
 * （自 1970-01-01 的天数）做加减法，绕开 Workers 跑在 UTC 的时区坑。
 */

/* ---------------------------------------------------------------
 * 中文数字（够用就好：0~99）
 * --------------------------------------------------------------- */
const CN_DIGIT = {
  '零': 0, '一': 1, '二': 2, '两': 2, '俩': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9
};

export function cn2num(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return null;
  if (/^\d+\.\d+$/.test(s)) return parseFloat(s);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s.length === 1 && CN_DIGIT[s] !== undefined) return CN_DIGIT[s];
  if (s === '十') return 10;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    if ((a && CN_DIGIT[a] === undefined) || (b && CN_DIGIT[b] === undefined)) return null;
    const tens = a ? CN_DIGIT[a] : 1;
    const ones = b ? CN_DIGIT[b] : 0;
    return tens * 10 + ones;
  }
  return null;
}

/* ---------------------------------------------------------------
 * 日期工具（全项目唯一的日期入口）
 * --------------------------------------------------------------- */

/** 'YYYY-MM-DD' → 天序号；格式错返回 NaN */
export function dayNum(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return NaN;
  const n = Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
  /* 2月30号这类不存在日期，Date.UTC 会静默滚动到下个月 —— 校验回来 */
  const back = new Date(n * 86400000);
  if (back.getUTCFullYear() !== +m[1] || back.getUTCMonth() !== +m[2] - 1 || back.getUTCDate() !== +m[3]) return NaN;
  return n;
}

/** 天序号 → 'YYYY-MM-DD' */
export function fromDayNum(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 加减天（n 可负） */
export function addDays(dateStr, n) {
  return fromDayNum(dayNum(dateStr) + n);
}

/** Python weekday()：周一=0 … 周日=6（JS getDay() 是周日=0，转换一下） */
export function weekdayPy(dateStr) {
  return (new Date(dayNum(dateStr) * 86400000).getUTCDay() + 6) % 7;
}

/** 北京时区的今天。Workers 跑在 UTC，直接 toISOString 会在
    北京时间 0:00~8:00 之间把「今天」算成昨天 —— 日期错乱的经典来源 */
export function shanghaiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 北京时区的当前 HH:MM */
export function shanghaiNowHHMM() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

/* ---------------------------------------------------------------
 * day 标记 → 具体日期（代码兜底，全项目唯一入口）
 * --------------------------------------------------------------- */

/**
 * token 取值：
 *   null / '' / 'today' / 'yesterday' / 'before_yesterday'
 *   'day_offset:-3'   （大前天，-1/-2 也有现成标记所以不走这个）
 *   'weekday:N'       （N=0 是周一，对应 python weekday()）
 *   'YYYY-MM-DD'
 * 返回 { date, note }；认不出/非法时 { date: null, note: 错误说明 }。
 */
export function resolve_day_token(token, today) {
  today = today || shanghaiToday();
  const t = dayNum(today);
  if (Number.isNaN(t)) return { date: null, note: `today 不是合法日期：${today}` };

  if (token === null || token === undefined || token === '') {
    return { date: today, note: '今天' };
  }
  token = String(token).trim().toLowerCase();

  let m = /^day_offset:(-?\d+)$/.exec(token);
  if (m) {
    const off = Math.max(-365, Math.min(0, parseInt(m[1], 10)));   /* 记录没有未来，负数兜底 */
    return { date: addDays(today, off), note: `${Math.abs(off)}天前` };
  }

  if (token === 'today') return { date: today, note: '今天' };
  if (token === 'yesterday') return { date: addDays(today, -1), note: '昨天' };
  if (token === 'before_yesterday') return { date: addDays(today, -2), note: '前天' };

  m = /^weekday:([0-6])$/.exec(token);
  if (m) {
    const target = parseInt(m[1], 10);
    /* 最近一个过去的该周几（含今天）。今天周三说「周四学的」→ 上周四 */
    const delta = (((weekdayPy(today) - target) % 7) + 7) % 7;
    return { date: addDays(today, -delta), note: '周' + '一二三四五六日'[target] };
  }

  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
  if (m) {
    const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const d = dayNum(iso);
    if (Number.isNaN(d)) return { date: null, note: `日期不存在：${token}` };
    if (d > t) {
      /* 带年份的明确未来日期直接拒绝（不带年份的「12月26号」在
         extract_day_token 里已经滚回去年了，不会走到这） */
      return { date: null, note: `${iso} 是未来的日期` };
    }
    if (t - d > 365) return { date: null, note: `${iso} 超过一年前，不让记` };
    return { date: iso, note: iso.slice(5) };
  }

  return { date: null, note: `认不出这个日期标记：${token}` };
}

/* ---------------------------------------------------------------
 * 日期词抽取
 * --------------------------------------------------------------- */

const _CN_WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const _CN_WEEKDAY = {};
for (let idx = 0; idx < 7; idx++) {
  for (const prefix of ['周', '星期', '礼拜']) {
    _CN_WEEKDAY[prefix + _CN_WEEKDAY_NAMES[idx]] = idx;
  }
  if (idx === 6) {
    _CN_WEEKDAY['周日'] = 6;
    _CN_WEEKDAY['星期天'] = 6;
    _CN_WEEKDAY['礼拜天'] = 6;
  }
}

/* 文本里出现的日期词 → 偏移天数。长词放前面，防止「昨晚」被「昨」截胡。 */
const _DAY_WORDS = [
  ['大前天', -3], ['昨天', -1], ['昨晚', -1], ['昨夜', -1],
  ['前天', -2], ['今天', 0], ['今日', 0], ['今晚', 0], ['今早', 0]
];
/* 只用于从正文里剔除的时间段词（不影响日期归属） */
const _TIME_OF_DAY = ['凌晨', '大清早', '一大早', '早上', '上午', '中午', '午后',
  '下午', '傍晚', '晚上', '夜里', '深夜', '半夜', '早上好'];

/**
 * 从原文里找日期词，返回 { token, rest }。
 * token 是相对标记（给 resolve_day_token 用），正文里把日期词剔掉；
 * 找不到时 token 为 null。
 */
export function extract_day_token(text, today) {
  today = today || shanghaiToday();

  for (const [word, offset] of _DAY_WORDS) {
    if (text.includes(word)) {
      if (offset === -3) {                      /* 大前天没有现成英文标记，走偏移标记 */
        return { token: 'day_offset:-3', rest: text.replace(word, '') };
      }
      const token = { 0: 'today', '-1': 'yesterday', '-2': 'before_yesterday' }[String(offset)];
      return { token, rest: text.replace(word, '') };
    }
  }

  let m = /(\d{1,2})月(\d{1,2})[日号]/.exec(text);
  if (m) {
    const month = +m[1], day = +m[2];
    const thisYear = dayNum(`${today.slice(0, 4)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    if (Number.isNaN(thisYear)) return { token: null, rest: text };
    const t = dayNum(today);
    let d = thisYear;
    if (d - t > 1) {                            /* 未来 → 多半是去年 */
      const lastYear = dayNum(`${+today.slice(0, 4) - 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      if (Number.isNaN(lastYear)) return { token: null, rest: text };
      d = lastYear;
    }
    return { token: fromDayNum(d), rest: text.replace(m[0], '') };
  }

  for (const [word, idx] of Object.entries(_CN_WEEKDAY)) {
    if (text.includes(word)) {
      return { token: `weekday:${idx}`, rest: text.replace(word, '') };
    }
  }

  return { token: null, rest: text };
}

/* ---------------------------------------------------------------
 * 学习记录正则快车道
 * --------------------------------------------------------------- */

/* 科目同义词 → 规范科目名。长的放前面（「计算机网络」要在「网络」之前匹配） */
export const SUBJECT_SYNONYMS = [
  ['数据结构', ['数据结构', '数据结构与算法', 'DS']],
  ['操作系统', ['操作系统', '操统', 'OS']],
  ['计算机组成原理', ['计算机组成原理', '组成原理', '计组']],
  ['计算机网络', ['计算机网络', '计网']],
  ['数学', ['数学', '高数', '高等数学', '线代', '线性代数', '概率论', '概率', '数一', '数二', '数学一', '数学二']],
  ['408', ['408', '专业课']],          /* 408 要排在英语前：「408真题」归 408 而不是英语 */
  ['英语', ['英语', '单词', '阅读', '作文', '长难句', '语法', '真题']],
  ['政治', ['政治', '马原', '肖四', '肖八', '1000题']]
];
/* 匹配时按「同义词长度」降序，防止「数据结构」被「数据」抢先 —— 这里没有「数据」，
   但规矩立好，加短同义词时不踩坑 */
const _ALL_SYNONYMS = SUBJECT_SYNONYMS
  .flatMap(([canon, syns]) => syns.map(syn => [syn, canon]))
  .sort((a, b) => b[0].length - a[0].length);

const _LEADING_VERBS = ['复习了一遍', '复习了', '复习', '学了一遍', '学了', '学习', '刷了', '刷',
  '背了', '背', '看了', '看', '做了', '做', '练了', '练', '过了', '过了一遍',
  '过了一遍', '写了', '写', '整理了', '整理', '过了一轮', '预习了', '预习'];

export function _match_duration(text) {
  /* 从文本里找时长（分钟）和它占用的原文片段。返回 { minutes, span } 或 null */
  const patterns = [
    /* 一个半小时 / 1个半小时 / 两小时半 / 半小时（兜底单独列在后面） */
    [/([0-9一二两三四五六七八九十俩]+(?:\.[0-9]+)?)\s*个?\s*半\s*(?:个\s*)?小时/, 'half'],
    [/([0-9一二两三四五六七八九十俩]+(?:\.[0-9]+)?)\s*个?\s*(?:小时|钟头|h|H)/, 'hour'],
    [/半\s*个?\s*小时/, 'half30'],
    [/([0-9一二两三四五六七八九十俩]+)\s*(?:多\s*)?(?:分钟|分|min)(?![钟表])/, 'min']
  ];
  for (const [pat, kind] of patterns) {
    const m = pat.exec(text);
    if (!m) continue;
    if (kind === 'half30') return { minutes: 30, span: m[0] };
    const num = cn2num(m[1]);
    if (num === null) continue;
    const minutes = kind === 'hour' ? Math.round(num * 60)
      : kind === 'half' ? Math.round(num * 60 + 30)
        : Math.round(num);
    if (minutes >= 1 && minutes <= 1440) return { minutes, span: m[0] };
  }
  return null;
}

export function _match_subject(text) {
  /* 找科目。返回 { subject, span } 或 null */
  let best = null;
  for (const [syn, canon] of _ALL_SYNONYMS) {
    const idx = text.indexOf(syn);
    if (idx >= 0 && (best === null || syn.length > best.span.length)) {
      best = { subject: canon, span: syn };
    }
  }
  return best;
}

/* Python str.strip(chars) 的等价物 */
function _stripChars(s, chars) {
  const esc = chars.replace(/[\\\]\^-]/g, '\\$&');
  return s.replace(new RegExp(`^[${esc}]+|[${esc}]+$`, 'g'), '');
}

const _STRIP_1 = ' ，,。.、;；!！?？~的';
const _STRIP_2 = ' ，,。.、;；!！?？~的了';

/**
 * 正则快车道：一句常见的话 → 一条学习记录。
 * 返回 { subject, minutes, content, day_token } 或 null（认不出就交给 LLM）。
 * day_token 同样是相对标记，日期归属由 resolve_day_token 决定。
 */
export function try_parse_log(text, today) {
  if (!text) return null;

  const { token: day_token, rest: _rest } = extract_day_token(text, today);
  let rest = _rest;

  const dur = _match_duration(rest);
  if (!dur) return null;
  rest = rest.replace(dur.span, ' ');

  const sub = _match_subject(rest);
  if (!sub) {
    /* 没提科目但明确说了在学习（「学了俩小时」「整理了3小时错题本」）→ 归「其他」 */
    if (!/学|背|刷|练|看|做|复习|整理|错题|笔记|网课|预习|听/.test(rest)) return null;
  }
  const subject = sub ? sub.subject : '其他';
  rest = sub ? rest.replace(sub.span, ' ') : rest;

  /* 二次确认：「其他」必须带学习色彩（防「玩了2小时手机」蒙混过关） */
  if (subject === '其他' && !/学|背|刷|练|复习|做题|错题|笔记|网课|听课|视频课|预习|整理/.test(rest)) {
    return null;
  }

  /* 剩下的当内容备注：去时段词、去句首动词、去标点 */
  for (const w of _TIME_OF_DAY) rest = rest.split(w).join(' ');
  rest = _stripChars(rest, _STRIP_1);
  for (const verb of _LEADING_VERBS) {
    if (rest.startsWith(verb)) {
      rest = rest.slice(verb.length);
      break;
    }
  }
  rest = _stripChars(rest, _STRIP_2);
  const content = rest.replace(/\s{2,}/g, ' ').trim().slice(0, 200);

  return { subject, minutes: dur.minutes, content, day_token };
}
