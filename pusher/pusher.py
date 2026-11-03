"""
pusher.py —— 考研助手的「时钟 + 喇叭」（自 kaoyan bot 的 Pusher 模式移植）

职责只有两件事：
1. 定时触发云端 cron 接口生成内容（晨报/午间/晚间/周报/夜间习惯聚合）
   —— 接口在 Cloudflare Functions 上，LLM key 也在那边，这里只管踩点。
2. 每 30s 轮询云端通知队列（/api/admin/agent/outbox），把 channel 为
   qq/all 且未发送的条目经 NapCat 发到 QQ，发完标 sent。

部署（服务器上，与 AstrBot/NapCat 同机）：
  pip install aiohttp
  cp config.example.json config.json   # 填 cf_base / admin_token / NapCat 地址 / master_qq
  python pusher.py                     # 或用 pusher.service 挂 systemd

注意（都是 kaoyan 时期踩过的坑）：
- 别在同机开第二个 QQ 壳（会断 NapCat 快速登录）；这里只是 WS/HTTP 客户端，不算壳。
- 触发防重靠内存 fired-map（date+kind 当天只发一次）；进程重启最多多发一条。
- config.json 含令牌，权限 600，别进 git。
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone

import aiohttp

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('pusher')

RECONNECT_MIN = 3
RECONNECT_MAX = 60

CN_WEEKDAY = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']


def load_config(path='config.json'):
    with open(path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
    for key in ('cf_base', 'admin_token', 'master_qq'):
        if not cfg.get(key):
            raise SystemExit(f'config 缺少 {key}')
    cfg.setdefault('push_times', {})
    cfg['push_times'].setdefault('brief', '07:30')
    cfg['push_times'].setdefault('midday', '12:30')
    cfg['push_times'].setdefault('evening', '21:30')
    cfg['push_times'].setdefault('weekly', '21:00')
    cfg['push_times'].setdefault('learn', '23:50')
    cfg.setdefault('weekly_day', 6)          # 周日（python weekday(): 周一=0）
    cfg.setdefault('poll_interval', 30)
    cfg.setdefault('timezone', 'Asia/Shanghai')
    return cfg


def now_cn(cfg):
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(cfg['timezone']))
    except Exception:
        return datetime.now(timezone(timedelta(hours=8)))


class Cloud:
    """Cloudflare Functions 的客户端（只带令牌打自己人）"""

    def __init__(self, cfg, session):
        self.cfg = cfg
        self.session = session

    def _headers(self):
        return {'authorization': f"Bearer {self.cfg['admin_token']}",
                'content-type': 'application/json'}

    async def trigger_cron(self, kind, dry=False):
        url = f"{self.cfg['cf_base'].rstrip('/')}/api/admin/agent/cron/{kind}"
        if dry:
            url += '?dry=1'
        try:
            async with self.session.post(url, headers=self._headers(), timeout=aiohttp.ClientTimeout(total=90)) as resp:
                text = await resp.text()
                if resp.status >= 400:
                    log.warning('cron %s HTTP %s：%s', kind, resp.status, text[:200])
                    return None
                return json.loads(text)
        except Exception as e:
            log.warning('cron %s 失败：%s', kind, e)
            return None

    async def take_outbox(self, take=20):
        url = f"{self.cfg['cf_base'].rstrip('/')}/api/admin/agent/outbox?take={take}"
        try:
            async with self.session.get(url, headers=self._headers(), timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status >= 400:
                    return []
                data = await resp.json()
                items = data.get('items') or []
                # 只发 QQ 相关的：channel 是 qq 或 all
                return [i for i in items if not i.get('sent') and i.get('channel') in ('qq', 'all')]
        except Exception as e:
            log.warning('拉取 outbox 失败：%s', e)
            return []

    async def mark_sent(self, ids):
        url = f"{self.cfg['cf_base'].rstrip('/')}/api/admin/agent/outbox"
        try:
            async with self.session.patch(url, headers=self._headers(),
                                          data=json.dumps({'ids': ids, 'sent': True}),
                                          timeout=aiohttp.ClientTimeout(total=30)) as resp:
                return resp.status < 400
        except Exception as e:
            log.warning('标记 sent 失败：%s', e)
            return False


class NapCat:
    """NapCat（OneBot v11）最小客户端：正向 WS 或 HTTP 二选一。

    ws 模式复用 kaoyan bot 的方案：{action, params, echo} + echo 配对回包。
    http 模式直接 POST /send_private_msg（NapCat「HTTP 服务器」开着才行）。
    """

    def __init__(self, cfg, session):
        self.ws_url = cfg.get('napcat_ws') or ''
        self.http_url = cfg.get('napcat_http') or ''
        self.access_token = cfg.get('napcat_token') or ''
        self.session = session
        self._ws = None
        self._pending = {}
        self.connected = asyncio.Event()

    async def run_ws(self):
        """正向 WS 常驻：断线指数退避重连。"""
        backoff = RECONNECT_MIN
        while True:
            try:
                headers = {'Authorization': f'Bearer {self.access_token}'} if self.access_token else {}
                self._ws = await self.session.ws_connect(self.ws_url, headers=headers)
                log.info('NapCat WS 已连接 %s', self.ws_url)
                self.connected.set()
                backoff = RECONNECT_MIN
                async for msg in self._ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        await self._on_packet(json.loads(msg.data))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning('NapCat WS 断开：%s，%ds 后重连', e, backoff)
            self.connected.clear()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX)

    async def _on_packet(self, data):
        echo = data.get('echo')
        if echo and echo in self._pending:
            self._pending[echo].set_result(data)

    async def send_private(self, user_id, message):
        params = {'user_id': int(user_id), 'message': message}
        if self.http_url:
            headers = {'Authorization': f'Bearer {self.access_token}'} if self.access_token else {}
            url = self.http_url.rstrip('/') + '/send_private_msg'
            async with self.session.post(url, headers=headers, json=params,
                                         timeout=aiohttp.ClientTimeout(total=30)) as resp:
                ok = resp.status < 400
                if not ok:
                    log.warning('NapCat HTTP 发送失败 HTTP %s', resp.status)
                return ok
        # WS 模式
        if not self._ws or self._ws.closed:
            log.warning('NapCat WS 未连接，这条先不发')
            return False
        echo = uuid4_str()
        fut = self._pending[echo] = asyncio.get_event_loop().create_future()
        try:
            await self._ws.send_str(json.dumps({'action': 'send_private_msg', 'params': params, 'echo': echo}))
            resp = await asyncio.wait_for(fut, timeout=15)
            ok = resp.get('status') in ('ok', 'async')
            if not ok:
                log.warning('NapCat WS 发送回包异常：%s', str(resp)[:200])
            return ok
        except asyncio.TimeoutError:
            log.warning('NapCat WS 发送超时')
            return False
        finally:
            self._pending.pop(echo, None)


def uuid4_str():
    import uuid
    return uuid.uuid4().hex


class Pusher:
    """定时触发 + 队列轮询。fired-map 防重：date+kind 当天只踩一次点。"""

    def __init__(self, cfg, cloud: Cloud, napcat: NapCat):
        self.cfg = cfg
        self.cloud = cloud
        self.napcat = napcat
        self._fired = {}

    async def run(self):
        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception('tick 出错（下一轮继续）')
            await asyncio.sleep(self.cfg['poll_interval'])

    async def _tick(self):
        now = now_cn(self.cfg)
        self._prune_fired(now)

        # ---- 1. 定时触发 cron ----
        times = self.cfg['push_times']
        for kind in ('brief', 'midday', 'evening'):
            self._fire(kind, now, times[kind], now.strftime('%Y-%m-%d'))
        week_key = now.strftime('%G-W%V')
        if now.weekday() == self.cfg['weekly_day']:
            self._fire('weekly', now, times['weekly'], week_key)
        self._fire('learn', now, times['learn'], now.strftime('%Y-%m-%d'))

        # ---- 2. 轮询通知队列发 QQ ----
        items = await self.cloud.take_outbox()
        if items:
            sent_ids = []
            for item in items:
                ok = True
                for qq in self.cfg['master_qq']:
                    ok = await self.napcat.send_private(qq, item['text']) and ok
                if ok:
                    sent_ids.append(item['id'])
                    log.info('已推送 [%s] %s…', item.get('kind'), item['text'][:40].replace('\n', ' '))
            if sent_ids:
                await self.cloud.mark_sent(sent_ids)

    def _fire(self, kind, now, hhmm, key):
        full_key = f'{kind}:{key}'
        if full_key in self._fired:
            return
        current = now.strftime('%H:%M')
        if current >= hhmm:
            self._fired[full_key] = True
            asyncio.ensure_future(self._fire_now(kind))

    async def _fire_now(self, kind):
        result = await self.cloud.trigger_cron(kind)
        if result is None:
            # 触发失败允许下个轮询周期重试一次：解除当天标记
            self._fired = {k: v for k, v in self._fired.items() if not k.startswith(f'{kind}:')}
            return
        if result.get('queued'):
            log.info('已触发 %s（入队 %s）', kind, result.get('itemId', ''))
        else:
            log.info('触发 %s：无内容或 dry（%s）', kind, result.get('note', ''))

    def _prune_fired(self, now):
        """fired-map 只留最近两天的键，防无限膨胀"""
        cutoff = (now - timedelta(days=2)).strftime('%Y-%m-%d')
        self._fired = {k: v for k, v in self._fired.items()
                       if ':' not in k or k.split(':', 1)[1] >= cutoff or k.startswith('weekly:')}


async def main():
    cfg = load_config()
    async with aiohttp.ClientSession() as session:
        cloud = Cloud(cfg, session)
        napcat = NapCat(cfg, session)
        pusher = Pusher(cfg, cloud, napcat)

        tasks = []
        if cfg.get('napcat_ws'):
            tasks.append(asyncio.create_task(napcat.run_ws()))
            # 等 WS 连上再开始推（连不上也照常触发 cron，站内提醒不受影响）
            try:
                await asyncio.wait_for(napcat.connected.wait(), timeout=15)
            except asyncio.TimeoutError:
                log.warning('NapCat WS 15s 未连上，先跑起来（发送会重试）')
        log.info('pusher 启动：cf=%s 推送时间=%s', cfg['cf_base'], cfg['push_times'])
        await pusher.run()
        for t in tasks:
            t.cancel()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
