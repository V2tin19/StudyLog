/**
 * _llm.js —— OpenAI 兼容接口的 LLM 客户端（服务端版）
 *
 * 约定（改这里之前先读，都是 kaoyan bot 时期真故障换来的）：
 * 1. 所有需要结构化输出的任务走「严格 JSON」prompt（response_format json_object），
 *    解析失败带着错误重试一次；有的网关不认 response_format，400 时自动降级重发。
 * 2. 推理型模型可能返回空 content —— 空响应按失败重试一次并放大 token 预算。
 * 3. 部分网关会把正常响应包成 {"success":true,"data":{...}} 信封 —— 解析时自动解一层。
 * 4. 日期永不由 LLM 直接产出：抽取类任务只许输出 day 标记，最终日期由
 *    _nlu.resolve_day_token 在代码里解析。
 *
 * 环境变量（Cloudflare Pages 项目设置里配）：
 *   LLM_API_KEY     必填
 *   LLM_BASE_URL    默认 https://api.deepseek.com
 *   LLM_MODEL       默认 deepseek-chat（便宜，跑意图抽取/日志补全）
 *   LLM_MODEL_STRONG 可选（跑周报这类一次性的重活，不配则回落 LLM_MODEL）
 */

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

export class LLMError extends Error { }

export function llmConfig(env) {
  return {
    apiBase: String(env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ''),
    apiKey: String(env.LLM_API_KEY || ''),
    model: String(env.LLM_MODEL || DEFAULT_MODEL),
    modelStrong: String(env.LLM_MODEL_STRONG || env.LLM_MODEL || DEFAULT_MODEL)
  };
}

export function llmReady(env) {
  const c = llmConfig(env);
  return !!c.apiKey;
}

/**
 * 剥掉代码围栏、找第一段平衡的花括号。
 * 顺便解 {"success":..,"data":{..}} 网关信封。
 */
export function extractJson(text) {
  const stripped = String(text || '').trim()
    .replace(/^```(?:json)?\s*/gm, '')
    .replace(/\s*```\s*$/gm, '')
    .trim();
  const start = stripped.indexOf('{');
  if (start === -1) throw new ValueError('没有 JSON 对象');
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') {
      depth--;
      if (depth === 0) {
        let obj = JSON.parse(stripped.slice(start, i + 1));
        /* CLINE 一类网关会把真实载荷包进 data 字段 */
        if (obj && typeof obj === 'object' && !Array.isArray(obj)
          && typeof obj.success === 'boolean' && obj.data && typeof obj.data === 'object'
          && Object.keys(obj.data).length) {
          obj = obj.data;
        }
        return obj;
      }
    }
  }
  throw new ValueError('JSON 没闭合');
}

function ValueError(msg) {
  const e = new Error(msg);
  e.name = 'ValueError';
  return e;
}

/**
 * 裸调用。返回助手文本。
 * 5xx / 空内容各自动重试一次（重试时放大 token 预算，喂饱推理型模型）。
 */
export async function llmChat(env, messages, opts = {}) {
  const c = llmConfig(env);
  if (!c.apiKey) throw new LLMError('环境变量 LLM_API_KEY 还没配');
  const {
    maxTokens = 1500, temperature = 0.4, forceJson = false,
    model, timeoutMs = 90000
  } = opts;

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = {
      model: model || c.model,
      messages,
      max_tokens: attempt === 0 ? maxTokens : Math.round(maxTokens * 1.6) + 500,
      temperature
    };
    if (forceJson) body.response_format = { type: 'json_object' };

    let resp, text;
    try {
      resp = await fetch(`${c.apiBase}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new LLMError(e.name === 'TimeoutError' ? 'LLM 请求超时' : `连不上 LLM 服务（${e.message || e}）`);
      continue;
    }

    if (resp.status >= 400) {
      /* 有的中转不认 response_format，明确拒绝时去掉该字段重发一次 */
      if (resp.status === 400 && forceJson && /response_format/i.test(text)) {
        try {
          const retry = await fetch(`${c.apiBase}/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, response_format: undefined }),
            signal: AbortSignal.timeout(timeoutMs)
          });
          const rtext = await retry.text();
          if (retry.status < 400) {
            const data = JSON.parse(rtext);
            const content = data?.choices?.[0]?.message?.content;
            if (content && content.trim()) return content.trim();
          }
        } catch { /* 落到下面的统一报错 */ }
      }
      throw new LLMError(`LLM 接口报错（HTTP ${resp.status}）：${text.slice(0, 200)}`);
    }

    try {
      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content;
      if (!content || !String(content).trim()) {
        lastErr = new LLMError('LLM 返回了空内容');
        continue;       /* 推理型模型烧完预算就是这样，重试 + 放大预算 */
      }
      return String(content).trim();
    } catch (e) {
      if (e instanceof LLMError) { lastErr = e; continue; }
      throw new LLMError(`LLM 返回结构异常：${text.slice(0, 200)}`);
    }
  }
  throw lastErr || new LLMError('LLM 调用失败');
}

/**
 * 严格 JSON 调用：system + user → 解析好的对象。
 * 解析失败把错误喂回去重试一次（LLM 自纠错）。
 */
export async function llmChatJson(env, system, user, opts = {}) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llmChat(env, messages, { ...opts, forceJson: true });
    try {
      return extractJson(raw);
    } catch (e) {
      if (attempt === 0) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content: `上面的输出不是合法 JSON（${e.message}）。重新输出，只输出 JSON 本身，不要任何解释或代码围栏。`
        });
        continue;
      }
      throw new LLMError('LLM 连续两次都没能输出合法 JSON');
    }
  }
  throw new LLMError('unreachable');
}
