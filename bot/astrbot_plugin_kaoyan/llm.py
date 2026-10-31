"""llm.py —— OpenAI 兼容接口的 LLM 客户端 + 各任务提示词

约定（改这里之前先读）：
1. 所有需要结构化输出的任务都走「严格 JSON」prompt，解析失败带错误重试一次。
2. 日期永不由 LLM 直接产出：抽取类任务只许输出 day 标记
   （today / yesterday / before_yesterday / monday~sunday / YYYY-MM-DD / null），
   最终日期由 nlu.resolve_day_token 在代码里解析。
3. 排计划类任务的输出会经过 kaoyan-plan 接口的服务端校验，
   但这里也先做一道宽松检查，坏 JSON 别往上送。

兼容任何 OpenAI 格式的服务（GLM / DeepSeek / Qwen / OpenAI 本家 / 各类中转）。
"""

import asyncio
import json
import logging
import re

import aiohttp

log = logging.getLogger('llm')


class LLMError(Exception):
    pass


TODAY_TOKEN_RULE = (
    'day 字段的取值只能是以下标记之一，禁止输出别的：'
    '"today"（今天）、"yesterday"（昨天）、"before_yesterday"（前天）、'
    '"monday"~"sunday"（最近一个过去的该星期几）、'
    '"YYYY-MM-DD"（明确的过去某天）、null（没提日期，默认今天）。'
    '禁止把"今天"翻译成具体日期，具体日期由系统负责。'
)


class LLM:
    def __init__(self, api_base: str, api_key: str, model: str,
                 json_mode: bool = True, timeout: int = 90):
        self.api_base = (api_base or '').rstrip('/')
        self.api_key = api_key
        self.model = model
        self.json_mode = json_mode
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self._session = None

    async def _http(self):
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=self.timeout)
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    async def chat(self, messages, max_tokens=1500, temperature=0.4, force_json=False):
        """裸调用。返回助手文本。"""
        if not self.api_key or '你的' in self.api_key:
            raise LLMError('config 里还没填 LLM api_key')
        sess = await self._http()
        body = {
            'model': self.model,
            'messages': messages,
            'max_tokens': max_tokens,
            'temperature': temperature,
        }
        if self.json_mode and force_json:
            body['response_format'] = {'type': 'json_object'}
        try:
            async with sess.post(
                f'{self.api_base}/chat/completions',
                headers={'authorization': f'Bearer {self.api_key}',
                         'content-type': 'application/json'},
                json=body,
            ) as resp:
                text = await resp.text()
        except asyncio.TimeoutError:
            raise LLMError('LLM 请求超时')
        except aiohttp.ClientError as e:
            raise LLMError(f'连不上 LLM 服务（{e.__class__.__name__}）')

        if resp.status >= 400:
            raise LLMError(f'LLM 接口报错（HTTP {resp.status}）：{text[:200]}')
        try:
            data = json.loads(text)
            # CLINE 等网关会把标准响应包一层 {"success":..,"data":{...}}，解开
            if isinstance(data, dict) and 'choices' not in data and isinstance(data.get('data'), dict):
                if data.get('error'):
                    raise LLMError(f'LLM 网关报错：{data["error"]}')
                data = data['data']
            if isinstance(data, dict) and data.get('error') and 'choices' not in data:
                raise LLMError(f'LLM 网关报错：{data["error"]}')
            content = data['choices'][0]['message']['content']
        except LLMError:
            raise
        except (ValueError, KeyError, IndexError):
            raise LLMError(f'LLM 返回结构异常：{text[:200]}')
        if not content or not content.strip():
            raise LLMError('LLM 返回了空内容')
        return content.strip()

    # ---------------- JSON 输出的稳妥解析 ----------------

    @staticmethod
    def _extract_json(text: str):
        """剥掉代码围栏、找第一段平衡的花括号。"""
        text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text.strip(), flags=re.M)
        start = text.find('{')
        if start == -1:
            raise ValueError('没有 JSON 对象')
        depth = 0
        for i in range(start, len(text)):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    return json.loads(text[start:i + 1])
        raise ValueError('JSON 没闭合')

    async def chat_json(self, system: str, user: str, max_tokens=2000):
        messages = [{'role': 'system', 'content': system},
                    {'role': 'user', 'content': user}]
        for attempt in range(2):
            raw = await self.chat(messages, max_tokens=max_tokens, force_json=True)
            try:
                return self._extract_json(raw)
            except ValueError as e:
                if attempt == 0:
                    messages.append({'role': 'assistant', 'content': raw})
                    messages.append({'role': 'user',
                                     'content': f'上面的输出不是合法 JSON（{e}）。重新输出，只输出 JSON 本身，不要任何解释或代码围栏。'})
                    continue
                raise LLMError('LLM 连续两次都没能输出合法 JSON')
        raise LLMError('unreachable')

    # ================= 任务：抽学习记录（正则快车道的兜底） =================

    async def extract_sessions(self, text: str, now_desc: str):
        """自然语言 → [{subject, minutes, content, day}]。day 是标记不是日期。"""
        system = (
            '你是考研学习记录助手。从用户消息里抽取学习记录，输出严格 JSON：\n'
            '{"sessions":[{"subject":"规范科目名","minutes":整数分钟,'
            '"content":"学了什么（≤100字，可为空字符串）","day":<day标记>}]}\n'
            '规范科目名尽量用：数学/英语/政治/数据结构/操作系统/计算机组成原理/计算机网络/其他。\n'
            '同义词要归一（高数→数学，单词→英语，计网→计算机网络）。\n'
            '一条消息里有多段学习就输出多条。\n'
            'minutes 按文本换算（一个半小时=90，半小时=30）。\n'
            f'现在的准确时间是：{now_desc}。\n' + TODAY_TOKEN_RULE + '\n'
            '用户消息里如果根本不是学习相关内容，输出 {"sessions":[]}。\n'
            '只输出 JSON。'
        )
        data = await self.chat_json(system, text, max_tokens=800)
        sessions = data.get('sessions')
        if not isinstance(sessions, list):
            raise LLMError('LLM 抽取结果里没有 sessions 数组')
        out = []
        for s in sessions[:10]:
            if not isinstance(s, dict):
                continue
            subject = str(s.get('subject') or '').strip()
            minutes = s.get('minutes')
            if not subject or not isinstance(minutes, (int, float)) or minutes <= 0:
                continue
            out.append({
                'subject': subject[:60],
                'minutes': int(minutes),
                'content': str(s.get('content') or '').strip()[:200],
                'day_token': s.get('day'),
            })
        return out

    # ================= 任务：按反馈重排某天 =================

    async def adjust_day(self, plan_day, feedback: str, now_desc: str, weekday_name: str):
        """根据「今天状态不好」类反馈重排某天的时段。"""
        system = (
            '你是考研计划调度助手。用户对当天的安排提出了状态反馈，'
            '你要重排这天的时段表，输出严格 JSON：\n'
            '{"slots":[{"start":"HH:MM","end":"HH:MM","subject":"科目","topic":"具体内容(≤30字)"}],'
            '"note":"给用户的一句话说明(≤50字)"}\n'
            '重排原则：\n'
            '- 状态差就降量：总学习时长压到原来的 50%~70%，插入休息段（subject 填「休息」）\n'
            '- 优先保留薄弱科目或今天最重要的科目，砍掉次要的\n'
            '- 时段必须互不重叠、end>start、都在同一天内（00:00~23:59）\n'
            '- 保留吃饭（午饭/晚饭）和睡觉前的缓冲\n'
            '- 23:30 之后不安排学习\n'
            f'现在是：{now_desc}（{weekday_name}）。已过去的时段不要重排，从当前时间之后的空档安排。\n'
            '只输出 JSON。'
        )
        user = f'用户反馈：{feedback}\n\n当天原计划（JSON）：\n{json.dumps(plan_day, ensure_ascii=False)}'
        return await self.chat_json(system, user, max_tokens=1200)

    # ================= 任务：生成本周计划 =================

    async def gen_week(self, context: dict):
        """生成未来 7 天的时段计划。context 里带考试倒计时、科目近况、每天可用时间。"""
        system = (
            '你是考研408全程规划专家。根据用户背景和近况，生成未来 7 天的学习计划，'
            '输出严格 JSON：\n'
            '{"days":{"YYYY-MM-DD":{"slots":[{"start":"HH:MM","end":"HH:MM",'
            '"subject":"科目","topic":"具体内容(≤30字)"}],"note":"当天要点(≤40字)"}},'
            '"template":{"1":[{"start":"HH:MM","end":"HH:MM","subject":"科目"}]},'
            '"summary":"本周整体思路(≤80字)"}\n'
            'template 是每周模板，键 "0"~"6"（"0"是周日），只放每天固定框架，可以只给常用的几天。\n'
            'days 的日期从明天开始连续 7 天，必须与用户给出的日期列表完全一致。\n'
            '科目只能在：数学/英语/政治/数据结构/操作系统/计算机组成原理/计算机网络/休息/锻炼 中选。\n'
            '原则：\n'
            '- 上午（9:00-12:00）给数学或难点科目，下午给 408 科目，晚上给英语/政治/复盘\n'
            '- 单时段 1~3 小时，时段互不重叠、end>start\n'
            '- 每天留出吃饭时间；每周留半天整休\n'
            '- 遵守用户给出的每天可用时间和阶段侧重\n'
            '- topic 要具体到章节/题型（如「王道DS第3章 栈与队列课后题」），不许写空话\n'
            '只输出 JSON。'
        )
        return await self.chat_json(system, json.dumps(context, ensure_ascii=False), max_tokens=3500)

    # ================= 任务：规划会话（教练式收集信息 → 草图 → 确认） =================

    async def plan_intake(self, known: dict, text: str, now_desc: str, has_plan: bool):
        """规划对话的单轮推进。

        输入：known=已收集的要素（可能为空），text=用户最新消息。
        输出（严格JSON）：collected(合并后全部已知) / questions(≤3个) /
        draft_summary(信息够时的文字版周草图) / ack(对用户说的话) /
        ready(信息是否够排计划) / confirm_detected(用户是否说了确认类的话)。
        """
        system = (
            '你是考研408备考规划教练，正在和用户对话式制定学习计划。'
            f'用户站点{"已有计划（可以覆盖重排）" if has_plan else "还没有计划"}。'
            '现在的准确时间：' + now_desc + '。\n\n'
            '每轮做三件事：\n'
            '1. 从用户最新消息里抽取规划要素，与已知合并（用户改口以最新为准）：\n'
            '   exam_date(考试日期YYYY-MM-DD) / daily_available(每天可用时段，如"晚上7-11，周末全天") /\n'
            '   wake_sleep(作息) / subjects_priority(科目强弱与优先级) / stage(基础|强化|冲刺) /\n'
            '   materials(教材网课与当前进度) / weekly_target(每周目标小时数) /\n'
            '   constraints(其他约束：上课实习等)。抽不到的字段保持原样，绝不编造。\n'
            '2. 判断信息是否足够排周计划：考试日期、每天可用时段、科目优先级，三者至少有其二，\n'
            '   且没有明显缺口。够则 ready=true。\n'
            '3. 输出严格JSON：\n'
            '{"collected":{...全部已知要素...},\n'
            ' "ready": false,\n'
            ' "questions":["最多3个问题，按对排期影响从大到小；没有就[]"],\n'
            ' "draft_summary":"ready时给文字版周计划草图：周一~周日各天重点科目与时段划分，≤220字；不够则空串",\n'
            ' "ack":"对用户说的话：确认收到信息+自然地提出questions里的追问，≤100字；"\n'
            '       "ready时则给出草图并问：就按这个排吗？说「按这个排」我就生成详细计划写进系统",\n'
            ' "confirm_detected":false}\n'
            '原则：一次最多问3个、优先问影响时段安排的（考试日期>可用时间>作息>科目强弱）；\n'
            '已知的绝不重复问；用户给了新信息先确认收到。只输出JSON。'
        )
        user = json.dumps({'known': known, '用户最新消息': text}, ensure_ascii=False)
        return await self.chat_json(system, user, max_tokens=1200)

    # ================= 任务：周报 =================

    async def weekly_report(self, stats: dict, diary_entries: list):
        """数据在代码里算好，LLM 只负责把数据讲成一段有判断力的周报。"""
        system = (
            '你是考研备考教练。根据给定的本周学习数据写一份周报，用纯文本（不要 markdown 标记），'
            '结构：\n'
            '1. 一句话总评（本周状态）\n'
            '2. 各科目情况（基于数据，点出偏科）\n'
            '3. 健康评估：解释分数构成（出勤/时长/计划符合/连续性/心态），指出最该改的一件事\n'
            '4. 下周建议：2~3 条，具体可执行，基于数据而非套话\n'
            '语气像熟悉学生的学长：直接、具体、有温度，不灌鸡汤。全文 ≤400 字。'
        )
        user = json.dumps({'stats': stats, '日记摘要': diary_entries}, ensure_ascii=False)
        return await self.chat([{'role': 'system', 'content': system},
                                {'role': 'user', 'content': user}], max_tokens=1200, temperature=0.6)

    # ================= 任务：闲聊兜底 =================

    async def chat_reply(self, text: str, context: str):
        system = (
            '你是考研备考助手 bot。用户发了一句你没专门功能的话，简短友好地回应（≤80字）。\n'
            '你可以：记录学习（"今天学了2小时数学"）、查安排（"今天安排"）、'
            '按状态调整（"今天状态不好"）、生成周计划（"重排本周"）、周总结（"本周总结"）、打卡（"打卡"）。\n'
            '回应里可以顺带提示最相关的功能。不要编造学习数据。\n'
            f'用户近况：{context}'
        )
        return await self.chat([{'role': 'system', 'content': system},
                                {'role': 'user', 'content': text}],
                               max_tokens=300, temperature=0.7)
