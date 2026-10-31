"""astrbot_plugin_kaoyan —— 考研自习助手（AstrBot 插件版）

和独立 bot 版的分工：
· 本插件跑在 AstrBot 主进程里，复用 AstrBot 自己的 NapCat 连接（同一个 QQ 号），
  不碰 NapCat 配置、不开新进程。
· 意图没命中时直接不产出结果 —— 消息继续走 AstrBot 主线（其他插件/人格 LLM），
  对原有 Yuki 行为零干扰。
· 数据仍落在 Cloudflare（StudyLog 站点），与写作台「考研」页同源。

配置在 AstrBot WebUI 的插件页里填（_conf_schema.json 定义）。
"""

import asyncio
import re

from astrbot.api import logger, AstrBotConfig
from astrbot.api.event import filter, AstrMessageEvent, MessageChain
from astrbot.api.star import Context, Star, StarTools

from apscheduler.triggers.cron import CronTrigger

from .cfstore import CFStore
from .llm import LLM
from .router import KaoyanRouter

# 粗筛：长得像考研意图才进路由（真正判断在 router 里，这里宁滥勿缺）
KAOYAN_RE = re.compile(
    r'帮助|菜单|指令|打卡|撤销|记错|撤回|总结|周报|复盘|汇报|重排|重新生成|重新安排|排一下|'
    r'考试日期|倒计时|安排|计划|日程|'
    r'状态不好|没状态|不在状态|状态差|学不动|不想学|学不进|生病|感冒|发烧|头疼|不舒服|失眠|'
    r'好累|太累|累了|疲惫|emo|丧|焦虑|有事|太忙|加班|'
    r'[0-9一二两三四五六七八九十俩]+\s*个?\s*(?:小时|钟头|分钟)|半小时|'
    r'学了|学完|背了|刷了|复习|学了多久|该学|学什么'
)

def _chunk(text: str, limit: int = 1800):
    text = text.strip()
    if len(text) <= limit:
        return [text] if text else []
    parts, buf = [], ''
    for para in text.split('\n'):
        if len(buf) + len(para) + 1 > limit and buf:
            parts.append(buf)
            buf = ''
        buf += para + '\n'
    if buf.strip():
        parts.append(buf)
    return parts


class KaoyanPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.cfg = config

        self.masters = self._parse_ids(config.get('master_qq', ''))
        self.groups = set(self._parse_ids(config.get('groups', '')))
        self.platform_id = str(config.get('platform_id', 'default') or 'default')

        api_base = str(config.get('site_api_base', '') or '').strip()
        admin_token = str(config.get('admin_token', '') or '').strip()
        llm_base = str(config.get('llm_api_base', '') or '').strip()
        llm_key = str(config.get('llm_api_key', '') or '').strip()
        llm_model = str(config.get('llm_model', '') or '').strip()

        self.cf = CFStore(api_base, admin_token) if api_base and admin_token else None
        self.llm = LLM(llm_base, llm_key, llm_model,
                       json_mode=bool(config.get('llm_json_mode', True))) \
            if llm_base and llm_key and llm_model else None
        self.router = KaoyanRouter(dict(config), self.cf, self.llm) \
            if (self.cf and self.llm) else None

        self.data_dir = None
        self._job_ids = []

        if self.router is None:
            logger.warning('[kaoyan] 配置不完整（site_api_base / admin_token / llm_*），'
                           '插件已加载但不会处理消息。请在 WebUI 插件配置里补全。')

    # ---------------- 生命周期 ----------------

    async def initialize(self):
        if self.router is None:
            return
        self.data_dir = StarTools.get_data_dir('astrbot_plugin_kaoyan')

        cron = getattr(self.context, 'cron_manager', None)
        scheduler = getattr(cron, 'scheduler', None)
        if scheduler is None:
            logger.warning('[kaoyan] 拿不到 cron_manager.scheduler，定时推送不可用')
            return

        tz = str(self.cfg.get('timezone', 'Asia/Shanghai') or 'Asia/Shanghai')
        if self.cfg.get('push_enabled', True):
            h, m = self._parse_time(self.cfg.get('daily_plan_time', '07:30'), 7, 30)
            self._add_job(scheduler, self._push_daily, f'kaoyan_daily_{id(self)}',
                          CronTrigger(hour=h, minute=m, timezone=tz))
            wd = str(self.cfg.get('weekly_report_day', 'sunday') or 'sunday').lower()
            wds = {'monday': 'mon', 'tuesday': 'tue', 'wednesday': 'wed', 'thursday': 'thu',
                   'friday': 'fri', 'saturday': 'sat', 'sunday': 'sun'}
            wh, wm = self._parse_time(self.cfg.get('weekly_report_time', '21:00'), 21, 0)
            self._add_job(scheduler, self._push_weekly, f'kaoyan_weekly_{id(self)}',
                          CronTrigger(day_of_week=wds.get(wd, 'sun'), hour=wh, minute=wm, timezone=tz))
            logger.info(f'[kaoyan] 定时推送已注册（时区 {tz}）')
        logger.info('[kaoyan] 考研插件就绪，等待消息')

    async def terminate(self):
        cron = getattr(self.context, 'cron_manager', None)
        scheduler = getattr(cron, 'scheduler', None)
        if scheduler:
            for jid in self._job_ids:
                try:
                    scheduler.remove_job(jid)
                except Exception:
                    pass
        self._job_ids = []
        if self.cf:
            await self.cf.close()
        if self.llm:
            await self.llm.close()

    def _add_job(self, scheduler, fn, job_id, trigger):
        try:
            scheduler.add_job(fn, trigger=trigger, id=job_id, replace_existing=True,
                              misfire_grace_time=300)
            self._job_ids.append(job_id)
        except Exception as e:
            logger.error(f'[kaoyan] 注册定时任务失败：{e}')

    # ---------------- 消息入口 ----------------

    @filter.regex(KAOYAN_RE, priority=100)
    async def on_kaoyan(self, event: AstrMessageEvent):
        if self.router is None:
            return

        text = event.get_message_str().strip()
        # 入口日志放所有检查之前（排障第一原则：静默失败查无可查）
        logger.info(f'[kaoyan] 命中粗筛 umo={event.unified_msg_origin} '
                    f'sender={event.get_sender_id()} text={text[:24]!r}')

        umo = event.unified_msg_origin
        try:
            platform_id, mtype, session_id = umo.split(':', 2)
        except ValueError:
            return
        is_group = (mtype == 'GroupMessage')
        sender = str(event.get_sender_id())

        # 门禁：私聊只服务 master；群聊只服务白名单群 + @bot + master
        if sender not in self.masters:
            logger.info(f'[kaoyan] 非master，放行主线 sender={sender}')
            return
        if is_group and (session_id not in self.groups or not self._at_me(event)):
            logger.info(f'[kaoyan] 群聊拦截（非白名单群或未@bot）session={session_id}')
            return

        reply = await self.router.handle(text, sender, is_group)
        if not reply:
            return          # 不是考研意图 —— 不产出结果，主线（人格/其他插件）继续

        yield event.plain_result(reply)
        event.stop_event()

    # 补一个显式的帮助指令（/考研帮助），绕过粗筛正则的覆盖面问题
    @filter.command('考研帮助', priority=100)
    async def kaoyan_help(self, event: AstrMessageEvent):
        sender = str(event.get_sender_id())
        if sender not in self.masters:
            return
        yield event.plain_result(
            '📖 考研助手（QQ 里直接说人话即可，下面是速查）：\n'
            '· 记学习：「今天下午学了2小时数据结构」\n'
            '· 查安排：「今天安排」「现在该学什么」\n'
            '· 调状态：「今天状态不好」（私聊）\n'
            '· 排计划：「重排本周计划」 · 周总结：「本周总结」\n'
            '· 打卡 / 撤销 / 「考试日期 2026-12-26」'
        )
        event.stop_event()

    # ---------------- 小工具 ----------------

    def _at_me(self, event: AstrMessageEvent) -> bool:
        try:
            self_id = str(event.get_self_id())
        except Exception:
            return False
        if not self_id:
            return False
        for comp in event.get_messages():
            if comp.__class__.__name__ == 'At' and str(getattr(comp, 'qq', '')) == self_id:
                return True
        return False

    @staticmethod
    def _parse_ids(raw) -> list:
        if isinstance(raw, (list, tuple)):
            parts = raw
        else:
            parts = str(raw or '').replace('，', ',').split(',')
        out = []
        for p in parts:
            p = str(p).strip()
            if p.isdigit():
                out.append(p)
        return out

    @staticmethod
    def _parse_time(raw, dh, dm):
        try:
            h, m = str(raw or '').split(':')
            return int(h), int(m)
        except Exception:
            return dh, dm

    # ---------------- 定时推送 ----------------

    async def _push_daily(self):
        try:
            if not self.router:
                return
            text = await self.router.daily_plan_push()
            if text:
                await self._broadcast(text)
                logger.info('[kaoyan] 已推每日计划')
        except Exception as e:
            logger.warning(f'[kaoyan] 每日计划推送失败：{e}')

    async def _push_weekly(self):
        try:
            if not self.router:
                return
            await self._broadcast(await self.router.weekly_report_push())
            logger.info('[kaoyan] 已推周报')
        except Exception as e:
            logger.warning(f'[kaoyan] 周报推送失败：{e}')

    async def _broadcast(self, text: str):
        for uid in self.masters:
            umo = f'{self.platform_id}:FriendMessage:{uid}'
            for chunk in _chunk(text):
                try:
                    await self.context.send_message(umo, MessageChain().message(chunk))
                except Exception as e:
                    logger.warning(f'[kaoyan] 推送给 {uid} 失败：{e}')
                await asyncio.sleep(1)   # 别把风控惹毛
