/**
 * _outbox.js —— 通知总线（站内 + QQ 共用一条队列）
 *
 * agent 的主动通知统一入队（晨报/午间查岗/晚间催日志/周报/排期提醒）：
 * - 网页端：铃铛轮询未读数，进助手页看列表、点已读；
 * - QQ：pusher 每 30s 轮询 channel=qq 且未发送的条目，经 NapCat 发出后标 sent。
 *
 * 存 doc key: agent_outbox —— { items: [{ id, ts, kind, text, channel, sent, read }] }
 * 只留 200 条：旧的已发已读先淘汰。
 */

import { readDoc, writeDoc, newId, nowIso } from './_store.js';

const MAX_ITEMS = 200;

export async function listItems(env, { channel = null, unsent = false, unread = false, take = 50 } = {}) {
  const { data } = await readDoc(env, 'agent_outbox');
  let items = data && Array.isArray(data.items) ? data.items : [];
  let list = items;
  if (channel) list = list.filter(i => i.channel === channel);
  if (unsent) list = list.filter(i => !i.sent);
  if (unread) list = list.filter(i => !i.read);
  return list.slice(0, take);
}

export async function unreadCount(env) {
  const { data } = await readDoc(env, 'agent_outbox');
  const items = data && Array.isArray(data.items) ? data.items : [];
  return items.filter(i => !i.read).length;
}

/** 入队一条通知。channel: 'qq'（pusher 发）| 'web'（站内铃铛）| 'all' */
export async function enqueue(env, { kind, text, channel = 'all' }) {
  const { data } = await readDoc(env, 'agent_outbox');
  const items = data && Array.isArray(data.items) ? data.items : [];
  const item = {
    id: newId(),
    ts: nowIso(),
    kind: String(kind || 'note').slice(0, 30),
    text: String(text || '').slice(0, 2000),
    channel,
    sent: false,
    read: false
  };
  items.unshift(item);
  /* 淘汰：优先丢已发+已读的，不够再丢最老的已发 */
  while (items.length > MAX_ITEMS) {
    const idxStale = items.findIndex(i => i.sent && i.read);
    const idxSent = items.findIndex(i => i.sent);
    const idx = idxStale >= 0 ? idxStale : (idxSent >= 0 ? idxSent : items.length - 1);
    items.splice(idx, 1);
  }
  await writeDoc(env, 'agent_outbox', { items });
  return item;
}

/** pusher 发完标 sent；网页看完标 read。可批量。 */
export async function markItems(env, ids, patch) {
  const { data } = await readDoc(env, 'agent_outbox');
  const items = data && Array.isArray(data.items) ? data.items : [];
  const idSet = new Set(Array.isArray(ids) ? ids : [ids]);
  let changed = 0;
  for (const i of items) {
    if (idSet.has(i.id)) {
      if (patch.sent !== undefined) i.sent = !!patch.sent;
      if (patch.read !== undefined) i.read = !!patch.read;
      changed++;
    }
  }
  if (changed) await writeDoc(env, 'agent_outbox', { items });
  return changed;
}
