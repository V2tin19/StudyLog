/**
 * /api/goal-suggestions —— 目标推荐（访客可写）
 *
 *   GET  ?limit=&offset=                已通过的目标（公开的「目标墙」）
 *   POST { title, note, name, hp }      推荐一个目标
 *
 * 跟书目荐读是同一个东西的两次应用，实现共用 _suggest.js。
 * 访客提交只写 goal_suggestions 这张表，碰不到 doc（站主的目标清单）——
 * 搬进清单是写作台在「通过」之后做的事。
 */

import { makePublicApi } from './_suggest.js';

const api = makePublicApi({
  table: 'goal_suggestions',
  titleMax: 60,
  titleMsg: '还没写目标',
  needTable: '目标推荐表还没建。可以在写作台「目标」页的推荐卡片上复制建表 SQL，去 D1 控制台跑一次。'
});

export const onRequestGet = api.onRequestGet;
export const onRequestPost = api.onRequestPost;
