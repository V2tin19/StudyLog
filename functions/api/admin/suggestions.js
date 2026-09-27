/**
 * /api/admin/suggestions —— 书目荐读的审核（需要令牌）
 *
 *   GET    ?filter=all|pending|approved|rejected
 *   PATCH  { id, action: 'approve' | 'reject' | 'imported' }
 *   POST   { ipHash }        拉黑
 *   DELETE ?id=              彻底删掉一条
 *
 * 实现全在 _suggest.js（跟「目标推荐」共用）。三个 action 的含义：
 *   approve   —— 通过，公开页的荐读墙会出现它
 *   reject    —— 不要
 *   imported  —— 「这本书已经搬进站主的书单了」，记一个时间戳
 *
 * 为什么「进书单」不是服务端做的 —— 那段理由写在 _suggest.js 顶部。
 */

import { makeAdminApi } from '../_suggest.js';

const api = makeAdminApi({
  table: 'book_suggestions',
  needTable: '荐读表还没建。请在 D1 控制台执行 schema.sql 里 book_suggestions 那一段。'
});

export const onRequestGet = api.onRequestGet;
export const onRequestPatch = api.onRequestPatch;
export const onRequestPost = api.onRequestPost;
export const onRequestDelete = api.onRequestDelete;
