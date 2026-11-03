/**
 * /api/admin/agent/chat —— 助手对话入口
 *
 *   GET  /api/admin/agent/chat              对话历史 + 待确认卡片（网页渲染用）
 *   POST /api/admin/agent/chat              说一句话
 *        body: { text: "今天学了2小时数学", source: "web" | "pusher" }
 *        body: { confirm: "c_xxx", payload: {...} }   确认卡片（payload 可带网页端改过的字段）
 *        body: { cancel: "c_xxx" }                     取消卡片
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 * 大脑在 functions/api/agent/_agent.js（关键词优先、LLM 兜底、日期代码解析）。
 */

import { json, dbMissing, requireAdmin } from '../../_shared.js';
import {
  handleAgentMessage, confirmCard, cancelCard
} from '../../agent/_agent.js';
import { readDoc } from '../../agent/_store.js';

const NO_STORE = { 'cache-control': 'no-store' };

/* ---------------- GET：对话历史 ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const { data } = await readDoc(env, 'agent_chat');
  const doc = data && typeof data === 'object' ? data : {};
  const pending = [];
  for (const [id, card] of Object.entries(doc.pending || {})) {
    pending.push({ id, type: card.type, payload: card.payload, ts: card.ts });
  }
  const { data: undo } = await readDoc(env, 'agent_undo');

  return json({
    ok: true,
    messages: Array.isArray(doc.messages) ? doc.messages : [],
    pending,
    undoCount: Array.isArray(undo) ? undo.length : 0
  }, 200, NO_STORE);
}

/* ---------------- POST：说一句话 / 处理卡片 ---------------- */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE);
  }
  if (!body || typeof body !== 'object') return json({ error: '请求体不能为空' }, 400, NO_STORE);

  try {
    if (body.confirm) {
      const r = await confirmCard(env, String(body.confirm), body.payload || null);
      return json({ ok: true, ...r }, 200, NO_STORE);
    }
    if (body.cancel) {
      const r = await cancelCard(env, String(body.cancel));
      return json({ ok: true, ...r }, 200, NO_STORE);
    }
    if (body.undo) {
      const r = await handleAgentMessage(env, '撤销', { source: body.source || 'web' });
      return json({ ok: true, ...r }, 200, NO_STORE);
    }
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return json({ error: '需要有 text 字段' }, 400, NO_STORE);
    }
    const r = await handleAgentMessage(env, body.text, { source: body.source || 'web' });
    return json({ ok: true, ...r }, 200, NO_STORE);
  } catch (e) {
    return json({ error: '处理失败：' + (e.message || e) }, 500, NO_STORE);
  }
}
