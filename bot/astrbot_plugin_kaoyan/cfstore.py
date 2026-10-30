"""cfstore.py —— Cloudflare Pages 后端的 API 客户端

对应仓库里 functions/api/admin/ 下的接口：
  GET  /api/admin/kaoyan-plan                读计划
  PUT  /api/admin/kaoyan-plan                写计划
  GET  /api/admin/study-session?days=N       最近 N 天学习记录 + 打卡
  POST /api/admin/study-session              服务端合并写：记录 / 打卡
  DELETE /api/admin/study-session?id=        撤销一条
  GET  /api/diary                            公开日记（周报拿心情用，不用令牌）

所有请求都带超时；失败抛 CFError，文案直接给人看。
"""

import asyncio
import json as _json

import aiohttp


class CFError(Exception):
    pass


class CFStore:
    def __init__(self, api_base: str, admin_token: str, timeout: int = 20):
        self.api_base = (api_base or '').rstrip('/')
        self.token = admin_token
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self._session = None

    async def _http(self):
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=self.timeout)
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    def _auth_headers(self):
        return {'authorization': f'Bearer {self.token}', 'content-type': 'application/json'}

    async def _request(self, method: str, path: str, body=None, auth: bool = True):
        url = self.api_base + path
        sess = await self._http()
        try:
            async with sess.request(
                method, url,
                headers=self._auth_headers() if auth else {'content-type': 'application/json'},
                json=body if body is not None else None,
            ) as resp:
                text = await resp.text()
        except asyncio.TimeoutError:
            raise CFError('请求网站超时了，稍后再试')
        except aiohttp.ClientError as e:
            raise CFError(f'连不上网站（{e.__class__.__name__}），检查网络和 api_base')

        try:
            data = _json.loads(text)
        except ValueError:
            raise CFError(f'网站返回了非 JSON 内容（HTTP {resp.status}），检查 api_base 是否正确')
        if resp.status >= 400 or data.get('ok') is not True:
            raise CFError(data.get('error') or f'网站接口报错（HTTP {resp.status}）')
        return data

    # ---------------- 计划 ----------------

    async def get_plan(self):
        data = await self._request('GET', '/api/admin/kaoyan-plan')
        return data.get('plan') or {}, data.get('updatedAt') or '', bool(data.get('fresh'))

    async def put_plan(self, plan: dict):
        return await self._request('PUT', '/api/admin/kaoyan-plan', {'plan': plan})

    # ---------------- 学习记录 / 打卡 ----------------

    async def get_sessions(self, days: int = 30):
        data = await self._request('GET', f'/api/admin/study-session?days={int(days)}')
        return data.get('sessions') or [], data.get('checkin') or {}

    async def add_sessions(self, sessions: list):
        data = await self._request('POST', '/api/admin/study-session', {'sessions': sessions})
        return data.get('sessions') or []

    async def delete_session(self, session_id: str):
        return await self._request('DELETE', f'/api/admin/study-session?id={session_id}')

    async def checkin(self, date_str: str):
        return await self._request('POST', '/api/admin/study-session', {'checkin': date_str})

    # ---------------- 日记（公开读，周报要心情） ----------------

    async def get_diary(self, limit: int = 14):
        data = await self._request('GET', f'/api/diary?limit={int(limit)}', auth=False)
        return data.get('entries') or []
