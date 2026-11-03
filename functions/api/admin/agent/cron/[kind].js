/**
 * /api/admin/agent/cron/[kind] —— 定时推送的内容生成入口（pusher 按点触发）
 *
 *   POST /api/admin/agent/cron/brief     晨报 07:30（昨天 + 今日安排 + 倒计时）
 *   POST /api/admin/agent/cron/midday    午间查岗 12:30
 *   POST /api/admin/agent/cron/evening   晚间催日志 21:30
 *   POST /api/admin/agent/cron/weekly    周报（周日 21:00）
 *   POST /api/admin/agent/cron/learn     习惯聚合（夜间）
 *   任意 kind 支持 ?dry=1：只返回文案不入队（测试用）
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 *
 * 幂等性说明：接口本身无状态，重复 POST 会重复入队；
 * 防重由 pusher 的 fired-map 负责（date+kind 当天只触发一次）。
 */

import { json, dbMissing, requireAdmin } from '../../../_shared.js';
import {
  morningBriefText, middayNudgeText, eveningNudgeText, weeklyReportText
} from '../../../agent/_agent.js';
import { runLearn } from '../learn.js';
import { enqueue } from '../../../agent/_outbox.js';

const NO_STORE = { 'cache-control': 'no-store' };

const KINDS = {
  brief: { build: morningBriefText, label: '晨报' },
  midday: { build: middayNudgeText, label: '午间提醒' },
  evening: { build: eveningNudgeText, label: '晚间提醒' },
  weekly: { build: weeklyReportText, label: '周报' }
};

export async function onRequestPost({ env, request, params }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const kind = (params && params.kind) || '';
  const dry = new URL(request.url).searchParams.get('dry') === '1';

  try {
    /* 习惯聚合：不产生通知，跑完报摘要 */
    if (kind === 'learn') {
      const { summary } = await runLearn(env);
      return json({ ok: true, kind, summary, queued: false }, 200, NO_STORE);
    }

    const def = KINDS[kind];
    if (!def) return json({ error: `不认识的 kind：${kind}（可用：${Object.keys(KINDS).join('/')}）` }, 400, NO_STORE);

    const text = await def.build(env);
    if (!text) {
      return json({ ok: true, kind, text: '', queued: false, note: '没有可发的内容（如当天无安排）' }, 200, NO_STORE);
    }
    if (dry) {
      return json({ ok: true, kind, text, queued: false }, 200, NO_STORE);
    }
    const item = await enqueue(env, { kind, text, channel: 'all' });
    return json({ ok: true, kind, itemId: item.id, text, queued: true }, 200, NO_STORE);
  } catch (e) {
    return json({ error: `${kind} 生成失败：` + (e.message || e) }, 500, NO_STORE);
  }
}
