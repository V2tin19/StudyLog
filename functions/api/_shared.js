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
