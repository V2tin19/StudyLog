/**
 * /api/suggestions —— 书目荐读（访客可写）
 *
 *   GET  ?limit=&offset=                     已通过的推荐（公开的「荐读墙」）
 *   POST { title, author, note, name, hp }   推荐一本书
 *
 * ⚠️ 这是全站仅有的两个「不需要令牌的写接口」之一（另一个是 /api/comments）。
 * 具体实现全在 _suggest.js 里，跟「目标推荐」共用同一份 ——
 * 防护逻辑手抄两份的话，迟早一边加了规则另一边漏掉，而漏掉的那个就是缺口。
 *
 * 还有一条边界很重要：**访客提交本身只写 book_suggestions 这张表**，
 * 碰不到 doc（站主的书单）。把推荐搬进书单是站主在写作台点「通过」之后，
 * 由写作台自己做的事。原因见 _suggest.js 顶部的长注释。
 */

import { makePublicApi } from './_suggest.js';

const api = makePublicApi({
  table: 'book_suggestions',
  titleMax: 60,
  titleMsg: '还没写书名',
  needTable: '荐读表还没建。可以在写作台「阅读」页的荐读卡片上复制建表 SQL，去 D1 控制台跑一次。'
});

export const onRequestGet = api.onRequestGet;
export const onRequestPost = api.onRequestPost;
