"""napcat.py —— NapCat（OneBot v11）WebSocket 客户端

连接方式是「正向 WS」：bot 作为客户端去连 NapCat 开的 ws 服务，
bot 自己不用监听端口，NAT/防火墙都省事。
（NapCat 侧在 config 里开「WebSocket 服务器」，见 bot/README.md）

事件：NapCat 推 JSON，我们只关心 message（private/group）。
动作：发 {action, params, echo}，用 echo 号配对回包。
"""

import asyncio
import json
import logging
import uuid

import aiohttp

log = logging.getLogger('napcat')

RECONNECT_MIN = 3
RECONNECT_MAX = 60


class NapCatClient:
    def __init__(self, ws_url: str, access_token: str = '',
                 on_message=None, self_id: int = 0):
        self.ws_url = ws_url
        self.access_token = access_token
        self.on_message = on_message          # async fn(payload_dict)
        self.self_id = self_id
        self._session = None
        self._ws = None
        self._pending = {}                    # echo -> Future（动作回包）
        self._running = False
        self.connected = asyncio.Event()

    # ---------------- 连接 ----------------

    async def run(self):
        """常驻：连接断了就重连，指数退避。"""
        self._running = True
        backoff = RECONNECT_MIN
        while self._running:
            try:
                await self._connect_once()
                backoff = RECONNECT_MIN
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning('NapCat 连接异常：%s，%ds 后重连', e, backoff)
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                raise
            backoff = min(backoff * 2, RECONNECT_MAX)

    async def _connect_once(self):
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        headers = {}
        if self.access_token:
            headers['authorization'] = f'Bearer {self.access_token}'

        async with self._session.ws_connect(self.ws_url, headers=headers) as ws:
            self._ws = ws
            self.connected.set()
            log.info('已连上 NapCat：%s', self.ws_url)
            try:
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        await self._dispatch(msg.data)
                    elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        break
            finally:
                self.connected.clear()
                self._ws = None
                # 连接没了，等着的动作调用就别吊死
                for fut in self._pending.values():
                    if not fut.done():
                        fut.set_exception(RuntimeError('与 NapCat 的连接断开'))
                self._pending.clear()
        raise RuntimeError('连接被关闭')

    async def _dispatch(self, raw: str):
        try:
            payload = json.loads(raw)
        except ValueError:
            return

        # 动作回包（带 echo 的响应对应我们发出去的调用）
        echo = payload.get('echo')
        if echo and echo in self._pending:
            fut = self._pending.pop(echo)
            if not fut.done():
                fut.set_result(payload)
            return

        # 事件：只处理消息，其余（心跳/元事件/通知）忽略
        if payload.get('post_type') == 'message':
            if self.on_message:
                try:
                    await self.on_message(payload)
                except Exception:
                    log.exception('处理消息时出错')

    async def stop(self):
        self._running = False
        if self._ws is not None:
            await self._ws.close()
        if self._session and not self._session.closed:
            await self._session.close()

    # ---------------- 发送 ----------------

    async def _call(self, action: str, params: dict, timeout: float = 15):
        if self._ws is None:
            raise RuntimeError('还没连上 NapCat')
        echo = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending[echo] = fut
        try:
            await self._ws.send_str(json.dumps(
                {'action': action, 'params': params, 'echo': echo}, ensure_ascii=False))
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(echo, None)

    @staticmethod
    def _chunks(text: str, limit: int = 1800):
        """QQ 长消息容易吞字，按段落切开分几条发。"""
        text = text.strip()
        if len(text) <= limit:
            return [text] if text else []
        parts, buf = [], ''
        for para in text.split('\n'):
            if len(buf) + len(para) + 1 > limit and buf:
                parts.append(buf)
                buf = ''
            buf += (para + '\n')
        if buf.strip():
            parts.append(buf)
        return parts

    async def send_private(self, user_id: int, text: str):
        for chunk in self._chunks(text):
            await self._call('send_private_msg', {'user_id': user_id, 'message': chunk})

    async def send_group(self, group_id: int, text: str):
        for chunk in self._chunks(text):
            await self._call('send_group_msg', {'group_id': group_id, 'message': chunk})


def message_text(payload: dict):
    """从 OneBot v11 消息事件里抽出纯文本 + 是否 @ 了 bot。

    message 可能是字符串（原始消息）或段数组；统一走 raw_message 最省心。
    self_id 每个事件都带，用它精确判断 @ 的是不是本 bot（群里 @ 别人不搭话）。
    返回 (text, at_me, is_group)。
    """
    raw = str(payload.get('raw_message') or '')
    me = str(payload.get('self_id') or '')
    at_me = False
    segments = payload.get('message')
    if isinstance(segments, list):
        for seg in segments:
            if isinstance(seg, dict) and seg.get('type') == 'at':
                qq = str((seg.get('data') or {}).get('qq', ''))
                if qq == me:
                    at_me = True
    # NapCat 的 raw_message 里 @ 一般是 CQ 码，这里再兜一道
    import re
    m = re.search(r'\[CQ:at,qq=(\d+)[^\]]*\]', raw)
    if m:
        if m.group(1) == me:
            at_me = True
        raw = re.sub(r'\[CQ:[^\]]*\]', '', raw)
    text = raw.strip()
    return text, at_me, payload.get('message_type') == 'group'
