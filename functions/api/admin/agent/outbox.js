/**
 * /api/admin/agent/outbox —— 通知队列读写口
 *
 *   GET   /api/admin/agent/outbox?unread=1            站内未读（铃铛/列表用）
 *   GET   /api/admin/agent/outbox?channel=qq&unsent=1 pusher 拉待发
 *   POST  /api/admin/agent/outbox                     body: { kind, text, channel } 入队（测试/内部用）
 *   PATCH /api/admin/agent/outbox                     body: { ids:[...], sent?:true, read?:true }
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 */

import { json, dbMissing, requireAdmin } from '../../_shared.js';
import { listItems, enqueue, markItems, unreadCount } from '../../agent/_outbox.js';

const NO_STORE = { 'cache-control': 'no-store' };

export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const url = new URL(request.url);
  const opts = {
    channel: url.searchParams.get('channel') || null,
    unsent: url.searchParams.get('unsent') === '1',
    unread: url.searchParams.get('unread') === '1',
    take: Math.min(parseInt(url.searchParams.get('take') || '50', 10) || 50, 200)
  };
  const items = await listItems(env, opts);
  return json({ ok: true, items, unread: await unreadCount(env) }, 200, NO_STORE);
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  if (!body || !String(body.text || '').trim()) {
    return json({ error: '需要有 text 字段' }, 400, NO_STORE);
  }
  const channel = ['qq', 'web', 'all'].includes(body.channel) ? body.channel : 'all';
  const item = await enqueue(env, { kind: body.kind, text: body.text, channel });
  return json({ ok: true, item }, 200, NO_STORE);
}

export async function onRequestPatch({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  const ids = body && Array.isArray(body.ids) ? body.ids : (body && body.id ? [body.id] : null);
  if (!ids) return json({ error: '需要有 ids 数组' }, 400, NO_STORE);
  const patch = {};
  if (body.sent !== undefined) patch.sent = !!body.sent;
  if (body.read !== undefined) patch.read = !!body.read;
  const changed = await markItems(env, ids, patch);
  return json({ ok: true, changed, unread: await unreadCount(env) }, 200, NO_STORE);
}
