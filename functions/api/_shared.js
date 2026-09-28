/**
 * Cloudflare Pages Functions - 公共工具
 * 放在 api/ 目录下，被各个接口 import 复用。
 * 这个文件本身没有 onRequest 处理函数，所以它不是一个可访问的路由。
 */

/** 把数据库行转成前端认识的日记对象 */
export function toEntry(row) {
  let images = [];
  try {
    images = JSON.parse(row.images || '[]');
  } catch {
    images = [];
  }
  if (!Array.isArray(images)) images = [];

  return {
    date: row.date,
    content: row.content || '',
    mood: row.mood || '',
    review: row.review || '',
    images,
    pinned: !!row.pinned,
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || ''
  };
}

/** 统一的 JSON 响应 */
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

/** 数据库没绑定时的统一报错 */
export function dbMissing() {
  return json(
    { error: '数据库未绑定：请在 Cloudflare Pages 项目设置 → 绑定 里，把 D1 数据库绑定为变量名 DB' },
    500,
    { 'cache-control': 'no-store' }
  );
}

/** 定长字符串比较，避免靠响应耗时猜令牌 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 日期格式校验：必须是 YYYY-MM-DD，且是真实存在的日期 */
export function isValidDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 管理接口的令牌校验。
 * 通过返回 null；不通过返回一个可以直接 return 出去的响应。
 *
 * 抽在这里是因为有三个管理接口都要用 —— 各写一份迟早会走偏（改一处漏两处）。
 * 真正的关卡在服务端，前端隐藏按钮只是 UI 效果，不能当权限用。
 */
export function requireAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return json(
      { error: '服务端还没有设置 ADMIN_TOKEN 环境变量，请在 Pages 项目设置里添加后再试' },
      500,
      { 'cache-control': 'no-store' }
    );
  }

  const header = request.headers.get('Authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!provided || !safeEqual(provided, expected)) {
    return json({ error: '令牌不正确，无权操作' }, 401, { 'cache-control': 'no-store' });
  }
  return null;
}

/* ============================================================
   访客写接口的公用防护（留言 / 书目荐读共用）

   /api/comments 和 /api/suggestions 是全站仅有的两个
   「不需要令牌就能写」的入口。防护各写一份的话，迟早会
   一边加了新规则、另一边漏掉 —— 那漏掉的那个就是缺口。
   ============================================================ */

/**
 * 拉黑名单表名。
 *
 * 历史原因叫 comment_blocklist（最初只有留言在用），现在是「所有访客写接口」
 * 共用的黑名单。没改名：改名就得让已经建好表的环境重跑一次 SQL，
 * 收益只是名字好看，风险却是线上当场拉黑功能报错。
 */
export const BLOCKLIST_TABLE = 'comment_blocklist';

/* 允许做限流查询的表。写成白名单而不是直接把表名拼进 SQL —— 
   虽然调用方全是内部常量，但把「表名」当参数传出去这件事本身就该有闸门。 */
const RATE_TABLES = ['comments', 'book_suggestions', 'goal_suggestions'];

/** 表还没建的报错识别。D1 报的是 "no such table: xxx" */
export function isMissingTable(err) {
  return /no such table/i.test(String((err && err.message) || ''));
}

/** 缺少字段的报错识别。D1 报的是 "no such column: xxx" */
export function isMissingColumn(err) {
  return /no such column/i.test(String((err && err.message) || ''));
}

/** 常见国家与地区映射 */
const CN_PROVINCES = {
  'BJ': '北京', 'TJ': '天津', 'HE': '河北', 'SX': '山西', 'NM': '内蒙古',
  'LN': '辽宁', 'JL': '吉林', 'HL': '黑龙江', 'SH': '上海', 'JS': '江苏',
  'ZJ': '浙江', 'AH': '安徽', 'FJ': '福建', 'JX': '江西', 'SD': '山东',
  'HA': '河南', 'HEN': '河南', 'HB': '湖北', 'HUB': '湖北', 'HN': '湖南', 'HUN': '湖南',
  'GD': '广东', 'GX': '广西', 'HI': '海南', 'HAN': '海南', 'CQ': '重庆',
  'SC': '四川', 'GZ': '贵州', 'YN': '云南', 'XZ': '西藏', 'SN': '陕西',
  'SAX': '陕西', 'GS': '甘肃', 'QH': '青海', 'NX': '宁夏', 'XJ': '新疆',
  'HK': '中国香港', 'MO': '中国澳门', 'TW': '中国台湾',
  'BEIJING': '北京', 'TIANJIN': '天津', 'HEBEI': '河北', 'SHANXI': '山西',
  'INNER MONGOLIA': '内蒙古', 'NEIMENGGU': '内蒙古', 'LIAONING': '辽宁',
  'JILIN': '吉林', 'HEILONGJIANG': '黑龙江', 'SHANGHAI': '上海', 'JIANGSU': '江苏',
  'ZHEJIANG': '浙江', 'ANHUI': '安徽', 'FUJIAN': '福建', 'JIANGXI': '江西',
  'SHANDONG': '山东', 'HENAN': '河南', 'HUBEI': '湖北', 'HUNAN': '湖南',
  'GUANGDONG': '广东', 'GUANGXI': '广西', 'HAINAN': '海南', 'CHONGQING': '重庆',
  'SICHUAN': '四川', 'GUIZHOU': '贵州', 'YUNNAN': '云南', 'TIBET': '西藏',
  'XIZANG': '西藏', 'SHAANXI': '陕西', 'GANSU': '甘肃', 'QINGHAI': '青海',
  'NINGXIA': '宁夏', 'XINJIANG': '新疆', 'HONG KONG': '中国香港',
  'MACAO': '中国澳门', 'MACAU': '中国澳门', 'TAIWAN': '中国台湾'
};

const COMMON_COUNTRIES = {
  'US': '美国', 'JP': '日本', 'GB': '英国', 'UK': '英国', 'CA': '加拿大',
  'AU': '澳大利亚', 'SG': '新加坡', 'KR': '韩国', 'DE': '德国', 'FR': '法国',
  'RU': '俄罗斯', 'MY': '马来西亚', 'TH': '泰国', 'VN': '越南', 'PH': '菲律宾'
};

/**
 * 从 Cloudflare 请求中解析访客所在的省份/地区属地。
 * 依靠 Cloudflare Pages 原生挂载的 request.cf，零延迟、零外部依赖、不记录明文 IP。
 */
export function parseLocation(request) {
  if (!request) return '未知';

  let testLoc = request.headers && request.headers.get('x-test-location');
  if (testLoc) {
    try { testLoc = decodeURIComponent(testLoc); } catch {}
    return testLoc.trim();
  }

  const ip = clientIp(request);
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'local' || ip === 'localhost') {
    return '本地';
  }

  const cf = request.cf || {};
  const country = (cf.country || (request.headers && request.headers.get('CF-IPCountry')) || '').toUpperCase().trim();
  const region = (cf.region || '').trim();
  const regionCode = (cf.regionCode || '').toUpperCase().trim();

  if (country === 'CN') {
    if (regionCode && CN_PROVINCES[regionCode]) return CN_PROVINCES[regionCode];
    const cleanRegion = region.toUpperCase();
    if (cleanRegion && CN_PROVINCES[cleanRegion]) return CN_PROVINCES[cleanRegion];
    for (const [k, v] of Object.entries(CN_PROVINCES)) {
      if (k.length > 2 && cleanRegion.includes(k)) return v;
    }
    return '中国';
  }

  if (country === 'HK') return '中国香港';
  if (country === 'MO') return '中国澳门';
  if (country === 'TW') return '中国台湾';

  if (country && COMMON_COUNTRIES[country]) return COMMON_COUNTRIES[country];
  if (country) return country;

  return '未知';
}

/** IP → 加盐 SHA-256。库里只存这个，不存 IP 原文 */
export async function hashIp(ip, salt) {
  const bytes = new TextEncoder().encode(String(salt || 'studylog') + '|' + String(ip || ''));
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 访客的真实 IP。Cloudflare 会填 CF-Connecting-IP */
export function clientIp(request) {
  const direct = request.headers.get('CF-Connecting-IP');
  if (direct) return direct.trim();
  const fwd = request.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim();
}

/** 蜜罐命中？正常访客看不见那个框，只有机器人会老实填 */
export function honeyPotHit(body) {
  return !!String((body && body.hp) || '').trim();
}

/** 内容里带链接？垃圾内容几乎 100% 带链接，这条命中率极高 */
export function hasLink(text) {
  return /https?:\/\/|www\./i.test(String(text || ''));
}

/** 这个网络地址是否已被站主拉黑 */
export async function isBlocked(env, ipHash) {
  const row = await env.DB
    .prepare(`SELECT ip_hash FROM ${BLOCKLIST_TABLE} WHERE ip_hash = ?`)
    .bind(ipHash)
    .first();
  return !!row;
}

/** 拉黑一个网络地址（幂等：重复拉黑不报错） */
export async function blockIp(env, ipHash) {
  await env.DB
    .prepare(`INSERT OR IGNORE INTO ${BLOCKLIST_TABLE} (ip_hash, created_at) VALUES (?, ?)`)
    .bind(ipHash, new Date().toISOString())
    .run();
}

/** 解除拉黑 */
export async function unblockIp(env, ipHash) {
  await env.DB
    .prepare(`DELETE FROM ${BLOCKLIST_TABLE} WHERE ip_hash = ?`)
    .bind(ipHash)
    .run();
}

/**
 * 同 IP 限流：windowMs 内最多 max 条。
 * 这是真正的滚动窗口（按 created_at 现算），不是固定计数器 ——
 * 固定计数器在窗口边界上会突然放行一大批。
 */
export async function isRateLimited(env, table, ipHash, max, windowMs) {
  if (RATE_TABLES.indexOf(table) === -1) {
    throw new Error('isRateLimited: 不认识的表 ' + table);
  }
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ip_hash = ? AND created_at > ?`)
    .bind(ipHash, since)
    .first();
  const n = (row && typeof row.n === 'number') ? row.n : 0;
  return n >= max;
}
