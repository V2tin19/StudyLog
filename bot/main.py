"""main.py —— 考研 bot 入口

职责只有三件：
1. 读配置、把 NapCat / Cloudflare / LLM / handlers 拼起来
2. 消息事件 → 鉴权（只服务 master）→ handlers → 回复发出去
3. 定时推送：每天早上当日计划、每周日晚周报（进程内轮询，不引额外依赖）

运行：python main.py [--config config.json]   （在 bot/ 目录下）
"""

import argparse
import asyncio
import json
import logging
import sys
from datetime import timedelta

import napcat as napcat_mod
from cfstore import CFStore
from handlers import Handlers
from llm import LLM
from napcat import NapCatClient

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s [%(name)s] %(message)s',
    datefmt='%m-%d %H:%M:%S',
)
log = logging.getLogger('main')


def load_config(path: str) -> dict:
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)

    # 必填项早失败：跑到一半才发现没配 token 最伤人
    for section, key in [('site', 'api_base'), ('site', 'admin_token'), ('llm', 'api_key')]:
        v = (cfg.get(section, {}) or {}).get(key, '')
        if not v or '你的' in str(v):
            raise SystemExit(f'config 里 {section}.{key} 还没填（示例见 config.example.json）')
    masters = cfg.get('master_qq') or []
    if not masters or not all(isinstance(x, int) for x in masters):
        raise SystemExit('config.master_qq 要填你的 QQ 号数组，比如 [123456]')
    return cfg


class Pusher:
    """进程内定时推送。每 30 秒看一次表，靠「上次已发日期」防重复。"""

    def __init__(self, cfg, handlers: Handlers, napcat: NapCatClient):
        self.cfg = cfg
        self.handlers = handlers
        self.napcat = napcat
        self._fired = {}          # (kind, date_key) -> True，进程内存活期内有效
        push = cfg.get('push') or {}
        self.enabled = push.get('enabled', True)
        self.daily_time = push.get('daily_plan_time', '07:30')
        self.weekly_day = str(push.get('weekly_report_day', 'sunday')).lower()
        self.weekly_time = push.get('weekly_report_time', '21:00')
        self._weekday_index = {'monday': 0, 'tuesday': 1, 'wednesday': 2, 'thursday': 3,
                               'friday': 4, 'saturday': 5, 'sunday': 6}

    async def run(self):
        if not self.enabled:
            log.info('定时推送已关闭（push.enabled=false）')
            return
        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception('推送 tick 出错')
            await asyncio.sleep(30)

    async def _tick(self):
        now = self.handlers.now()
        hhmm = now.strftime('%H:%M')

        # 每天：早报（时间过了就算今天没发过就发，避免 bot 恰好整点重启错过）
        key = ('daily', now.date().isoformat())
        if hhmm >= self.daily_time and key not in self._fired:
            self._fired[key] = True
            try:
                text = await self.handlers.daily_plan_push()
                if text:
                    await self._broadcast(text)
                    log.info('已推每日计划')
            except Exception as e:
                log.warning('每日计划推送失败：%s', e)

        # 每周：周报
        target_wd = self._weekday_index.get(self.weekly_day, 6)
        week_key = ('weekly', now.date().isoformat())
        if now.weekday() == target_wd and hhmm >= self.weekly_time and week_key not in self._fired:
            self._fired[week_key] = True
            try:
                await self._broadcast(await self.handlers.weekly_report_push())
                log.info('已推周报')
            except Exception as e:
                log.warning('周报推送失败：%s', e)

        # 防字典膨胀：只留最近 30 天
        cutoff = (now - timedelta(days=30)).date().isoformat()
        self._fired = {k: v for k, v in self._fired.items()
                       if k[1] >= cutoff}

    async def _broadcast(self, text: str):
        for uid in self.cfg.get('master_qq', []):
            try:
                await self.napcat.send_private(uid, text)
            except Exception as e:
                log.warning('推送给 %s 失败：%s', uid, e)


async def on_message(payload: dict, cfg: dict, handlers: Handlers, napcat: NapCatClient):
    text, at_me, is_group = napcat_mod.message_text(payload)
    if not text:
        return
    user_id = payload.get('user_id') or 0

    if is_group:
        # 群聊：白名单内 + @bot 才响应；私聊：只服务 master
        if payload.get('group_id') not in (cfg.get('groups') or []):
            return
        if not at_me:
            return
        if user_id not in cfg.get('master_qq', []):
            return
    else:
        if user_id not in cfg.get('master_qq', []):
            return

    reply = await handlers.handle(text, user_id)
    if not reply:
        return
    try:
        if is_group:
            await napcat.send_group(payload['group_id'], reply)
        else:
            await napcat.send_private(user_id, reply)
    except Exception as e:
        log.warning('发消息失败：%s', e)


async def amain(cfg: dict):
    cf = CFStore(cfg['site']['api_base'], cfg['site']['admin_token'])
    llm = LLM(cfg['llm']['api_base'], cfg['llm']['api_key'], cfg['llm']['model'],
              json_mode=cfg['llm'].get('json_mode', True))
    handlers = Handlers(cfg, cf, llm)

    nc_cfg = cfg.get('napcat') or {}
    napcat = NapCatClient(
        ws_url=nc_cfg.get('ws_url', 'ws://127.0.0.1:3001'),
        access_token=nc_cfg.get('access_token', ''),
        on_message=lambda p: on_message(p, cfg, handlers, napcat),
    )

    pusher = Pusher(cfg, handlers, napcat)

    tasks = [
        asyncio.create_task(napcat.run(), name='napcat-ws'),
        asyncio.create_task(pusher.run(), name='pusher'),
    ]
    log.info('考研 bot 启动完成，等待 NapCat 连接…')
    try:
        await asyncio.gather(*tasks)
    finally:
        await napcat.stop()
        await cf.close()
        await llm.close()


def main():
    ap = argparse.ArgumentParser(description='StudyLog 考研 QQ bot')
    ap.add_argument('--config', default='config.json', help='配置文件路径（默认 bot/config.json）')
    args = ap.parse_args()
    cfg = load_config(args.config)
    try:
        asyncio.run(amain(cfg))
    except KeyboardInterrupt:
        log.info('收到退出信号，拜拜')
        sys.exit(0)


if __name__ == '__main__':
    main()
