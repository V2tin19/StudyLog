/**
 * /api/admin/goal-suggestions —— 目标推荐的审核（需要令牌）
 *
 *   GET    ?filter=all|pending|approved|rejected
 *   PATCH  { id, action: 'approve' | 'reject' | 'imported' }
 *   POST   { ipHash }        拉黑
 *   DELETE ?id=              彻底删掉一条
 *
 * 实现全在 _suggest.js（跟书目荐读共用）。通过之后由写作台把这条
 * 写进目标清单并标上推荐人 —— 服务端不碰 doc，理由见 _suggest.js 顶部。
 */

import { makeAdminApi } from '../_suggest.js';

const api = makeAdminApi({
  table: 'goal_suggestions',
  needTable: '目标推荐表还没建。请在 D1 控制台执行 schema.sql 里 goal_suggestions 那一段。'
});

export const onRequestGet = api.onRequestGet;
export const onRequestPatch = api.onRequestPatch;
export const onRequestPost = api.onRequestPost;
export const onRequestDelete = api.onRequestDelete;
