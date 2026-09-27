# Turnstile 配置教程（StudyLog 专用）

给「访客能写」的两个接口（`/api/comments` 留言、`/api/suggestions` 书目荐读）加上人机校验。

预计 30~40 分钟，全程不用改数据库。

---

## 0. 先说清楚它补的是哪一层

你现在的防护是四件套：

| 层 | 挡什么 | 挡不住什么 |
|---|---|---|
| 蜜罐 `hp` 字段 | 无脑扫表单的脚本 | **专门针对你站的填表机器人**（它会跳过不存在的字段） |
| 限流（1 分钟 3 条 / 24 小时 20 条） | 同一个 IP 猛刷 | 分散在很多 IP 上的刷量 |
| 链接过滤 | 广告垃圾 | 不带链接的垃圾（比如纯骚扰） |
| 拉黑名单 | 已经确认的坏 IP | 还没被发现的 |

缺的是**最前面那一层**：「这条请求到底是不是真人浏览器发出来的」。

Turnstile 干的就是这件事：在你表单里塞一小段东西，浏览器里跑完一串检查，产出一个 **token**；
你的服务端把 token 拿去 Cloudflare 问一句「这个是真的吗」，真的才继续。

三个关键事实（先记住，后面全用到）：

1. **token 只能用一次**，用完就废 —— 所以提交失败后必须换新的，不能拿旧的再试
2. **token 300 秒过期**（5 分钟）—— 用户打开页面发呆十分钟再提交，会失效
3. **必须在服务端校验**。只在页面上放个控件、不去问 Cloudflare = 等于没做

费用：免费版就够用 —— 验证次数不限制（官方写 unlimited challenges），限制在
「20 个 widget」「每个 widget 10 个域名」「分析数据看 7 天」。以官网为准。

---

## 1. 在 Cloudflare 后台创建 widget

1. 登录 Cloudflare → 左侧账号级别菜单找 **Turnstile**（不在某个域名下面，是账号级的）
   - 直接开：<https://dash.cloudflare.com/?to=/:account/turnstile>
2. 点 **Add widget / 添加站点**
3. 填三项：

| 字段 | 填什么 |
|---|---|
| Site name（站点名） | `StudyLog` —— 这只是给你自己看的标签 |
| Hostname（域名） | `studylog-eo0.pages.dev` —— **必须填**，填错 widget 不显示 |
| Widget Mode（模式） | 选 **Managed** |

   三种模式的区别：
   - **Managed（推荐）**：大部分访客完全无感，可疑的才弹一下
   - **Non-Interactive**：不弹交互，但会多跑几秒检查
   - **Invisible**：彻底看不见。**新手别选** —— 失败时你没法解释给用户听

4. 创建完，页面上会给你两个东西：

| 名字 | 长什么样 | 放哪 | 能不能泄露 |
|---|---|---|---|
| **Sitekey** | `0x4AAAAAAA...`（多半以 `0x4` 开头） | 前端代码里 | **可以**，它本来就是公开的 |
| **Secret Key** | 一长串随机字符 | **只放环境变量** | **绝对不行** —— 泄露了别人能伪造校验结果 |

> ⚠️ 两个 key 是**成对的**。把测试 sitekey 配生产 secret，校验必然失败，
> 而且报错会把你往「代码写错了」的方向带偏。见第 5 节的坑。

### 顺便把 localhost 加进去（可选）

想在本地也看到真的 widget 转一圈，就在这个 widget 的 **Settings → Hostname Management**
里补 `localhost` 和 `127.0.0.1`。不加也行 —— 本地用测试 key 更省事（第 5 节）。

---

## 2. 把 Secret Key 配到 Pages

1. Cloudflare → **Workers & Pages** → 你的 `studylog` 项目
2. **Settings（设置）** → **Variables and Secrets（环境变量）**
3. **Add**：

| 名字 | 值 | 类型 |
|---|---|---|
| `TURNSTILE_SECRET` | 第 1 步复制的 Secret Key | **Secret / 加密**（别选 Plaintext） |

> ⚠️ **改完环境变量必须重新部署才生效** —— 这是「明明配了却没反应」的头号原因。
> 只改环境变量、代码没动的话，Deployments → 最新一条 → **Retry deployment** 就够了。

> Sitekey 不用配环境变量，写在前端代码里就行（它是公开的），第 4 节会写。

---

## 3. 后端：加一个校验函数

打开 `functions/api/_shared.js`，在文件末尾追加：

```js
/**
 * 校验 Turnstile token。
 *   返回 null  → 通过
 *   返回字符串 → 拒绝原因（可以直接回给用户看）
 *
 * 没配 TURNSTILE_SECRET 时直接放行：本地离线验证、或者你还没开通时，
 * 不该被这个功能卡住。所以「配完了」这件事要单独验一次，见第 6 节。
 */
export async function verifyTurnstile(env, token, ip) {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return null;

  if (!token) return '人机校验没通过，刷新页面再试一次';

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', String(token));
  if (ip) form.append('remoteip', ip);      // 可选，能让判断更准

  let out;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
    out = await res.json();
  } catch {
    /* Cloudflare 那边连不上 —— 这是「没法判断」，不等于「判断为假」。
       蜜罐和限流还在，放过去比把正常访客挡在门外划算。 */
    return null;
  }

  if (out && out.success) return null;

  /* 想排查具体原因，可以在 Cloudflare → Pages → 部署日志里打这行：
     console.log('turnstile failed', out && out['error-codes']); */
  return '人机校验没通过，刷新页面再试一次';
}
```

然后**两个访客写接口各改一行**。以 `functions/api/suggestions.js` 为例：

```js
/* 顶部 import 里加上 verifyTurnstile */
import {
  json, dbMissing,
  isMissingTable, hashIp, clientIp, honeyPotHit, hasLink, isBlocked, isRateLimited,
  verifyTurnstile                                    // ← 新增
} from './_shared.js';
```

```js
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }

  /* ---- 1. 蜜罐（原来的代码，不动）---- */
  if (honeyPotHit(body)) return json({ ok: true, item: null }, 200, NO_STORE);

  /* ---- 1.5 人机校验（新增）----
     放在「便宜的先查、贵的后查」的位置上：它是「是不是真人」这一层，
     先过它，后面那些数据库查询就不用白跑了。 */
  const tsFail = await verifyTurnstile(env, body.ts, clientIp(request));
  if (tsFail) return json({ error: tsFail }, 403, NO_STORE);

  /* ---- 2. 内容校验（原来的代码，往下都不用动）---- */
  ...
}
```

`functions/api/comments.js` 同样加两处（import 一行 + 校验三行），位置也放在蜜罐后面。

> **为什么只加在这两个接口？**
> 写作台（`/api/admin/*`）**不要加**。那里已经有令牌校验了，而且是你自己在用 ——
> 每写一篇日记都让你过一次人机校验，纯属给自己添堵。

---

## 4. 前端：把控件放上去

### 4.1 引入脚本

`index.html` 的 `</body>` 前、`js/public-site.js` **之前**加一行：

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileReady" async defer></script>
```

- `render=explicit`：**不要**自动扫描页面，改由我们自己决定什么时候、往哪画。
  我们必须用显式渲染 —— 这个站的表单是 JS 动态生成的，自动扫描那一下根本扫不到
- `onload=onTurnstileReady`：脚本下载完之后调我们的函数，免得我们在它还没到位时就调用

### 4.2 在表单里留一个坑位

`js/public-site.js` 里，`suggestFormHtml()` 的蜜罐那行下面加一个空容器；
留言表单（`commentFormHtml` 之类）同样加：

```js
/* 人机校验的坑位。内容是 Turnstile 自己填的，我们只负责把它画进去 */
'<div class="ts-box"></div>' +
```

### 4.3 渲染 + 取 token

在 `js/public-site.js` 里加这一小段（放在文件靠上的位置，跟其他工具函数一起）：

```js
/* ===== Turnstile =====
   sitekey 是公开的，写死在代码里没问题。
   本地开发换成官方测试 key —— 它永远通过，也不会因为 localhost 不在白名单而报错。 */
function isLocal() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}
var TS_KEY = isLocal() ? '1x00000000000000000000AA' : '0x4AAAAAAA替换成你的sitekey';
var TS_ENABLED = true;       /* 想临时整个关掉，改成 false */

var tsReady = false;
var tsQueue = [];        /* 脚本还没加载完时，先把要画的排个队 */

/* —— 这个名字必须跟 index.html 里 onload= 的值一致 —— */
window.onTurnstileReady = function () {
  tsReady = true;
  while (tsQueue.length) tsQueue.shift()();
};

/* 把某个容器里的所有 .ts-box 画成 widget。容器是刚被 innerHTML 换出来的新 DOM，
   所以每次重渲染都要重新画一遍（旧的那份已经跟着 DOM 一起没了）。 */
function mountTurnstile(root, action) {
  if (!TS_ENABLED || !root) return;
  var boxes = root.querySelectorAll('.ts-box');
  Array.prototype.forEach.call(boxes, function (box) {
    if (box.getAttribute('data-on')) return;      /* 画过的别画第二次 */
    box.setAttribute('data-on', '1');

    var go = function () {
      if (!document.body.contains(box)) return;   /* 这个坑位已经被重渲染掉了 */
      try {
        box.__wid = turnstile.render(box, { sitekey: TS_KEY, action: action });
      } catch (e) {
        box.innerHTML = '<div class="pub-state">人机校验加载失败，刷新页面再试</div>';
      }
    };

    if (tsReady) go(); else tsQueue.push(go);
  });
}

/* 取 token。没画出来、没过、或者已过期，都返回空串 */
function turnstileToken(root) {
  if (!TS_ENABLED || !root) return '';
  var box = root.querySelector('.ts-box');
  if (!box || box.__wid == null || typeof turnstile === 'undefined') return '';
  return turnstile.getResponse(box.__wid) || '';
}

/* 提交失败了要把旧的作废掉，否则下一次提交拿的还是同一个「已用过」的 token */
function turnstileReset(root) {
  if (!TS_ENABLED || !root) return;
  var box = root.querySelector('.ts-box');
  if (box && box.__wid != null && typeof turnstile !== 'undefined') turnstile.reset(box.__wid);
}
```

然后**在三处接线**：

**① 表单画完之后调一次 `mountTurnstile`。** 比如荐读的 `renderSuggest()` 末尾：

```js
box.innerHTML = '<div class="pub-section">...' + suggestFormHtml() + wall + '</div>';
mountTurnstile(box, 'suggest');         // ← 新增
```

留言那几处渲染完表单的地方同理，`action` 传 `'comment'`。

**② 提交时把 token 带上。** `sendSuggestion()` 里，`body: JSON.stringify({...})` 加一个字段：

```js
body: JSON.stringify({
  title: title,
  author: (authorEl.value || '').trim(),
  note: (noteEl.value || '').trim(),
  name: name,
  hp: hpEl ? hpEl.value : '',
  ts: turnstileToken(form)          // ← 新增
})
```

`sendComment()` 同样加一行。

**③ 提交结束后 reset。** 在 `.finally(...)` 里加一句（成功失败都要 reset，
因为 token 无论是"用掉了"还是"没通过"都已经作废了）：

```js
.finally(function () {
  btn.disabled = false;
  btn.textContent = '推荐';
  turnstileReset(form);            // ← 新增
});
```

### 4.4 顺手加一点样式

`index.html` 的 `<style>` 里（公开页那一段）：

```css
.ts-box { margin-top: 10px; min-height: 0; }
```

不加也能用，只是间距会有点挤。

---

## 5. 本地怎么不被拦

这几种情况**不要**去动生产 key，会把自己绕进去：

| 场景 | 用什么 |
|---|---|
| 本地开发（`localhost` / `127.0.0.1`） | 上面 `isLocal()` 已经自动切成测试 key `1x00000000000000000000AA` |
| 想完全跳过校验 | 本地不配 `TURNSTILE_SECRET` —— 第 3 节的函数会直接放行 |
| 浏览器自动化 / 端到端测试 | 一律用测试 key，真的 Turnstile 会把 headless 浏览器当机器人拦掉 |

**官方测试 key 表**（复制可用，不用登录）：

| Sitekey | 行为 |
|---|---|
| `1x00000000000000000000AA` | 永远通过（可见） |
| `2x00000000000000000000AB` | 永远拦截（可见）—— 用来测你的错误提示长什么样 |
| `1x00000000000000000000BB` | 永远通过（不可见） |
| `2x00000000000000000000BB` | 永远拦截（不可见） |
| `3x00000000000000000000FF` | 强制弹出交互挑战 —— 用来测布局会不会被撑坏 |

| Secret Key | 行为 |
|---|---|
| `1x0000000000000000000000000000000AA` | 校验永远通过 |
| `2x0000000000000000000000000000000AA` | 校验永远失败 |
| `3x0000000000000000000000000000000AA` | 返回「token 已用过」 |

> ⚠️ **sitekey 和 secret 必须同一套**。测试 sitekey 配生产 secret（或反过来），
> siteverify 一定失败 —— 而且这个失败看起来跟"代码写错了"一模一样，最费时间。
> 本地想连测试 secret 一起验，就把 `TURNSTILE_SECRET` 临时设成 `1x0000000000000000000000000000000AA`。

---

## 6. 配完之后怎么验（别只看页面转不转圈）

只看到控件显示出来**不算成功** —— 控件是 Cloudflare 的 iframe，它转不转圈跟你的后端有没有在查，是两回事。

按顺序验这三条（`curl` 比开浏览器快，先跑它）：

```bash
# ① 带一个假 token 提交 → 期望 403
curl -sS -X POST https://studylog-eo0.pages.dev/api/suggestions \
  -H 'content-type: application/json' \
  -d '{"title":"测试","ts":"fake-token"}'

# ② 干脆不带 ts 字段 → 期望 403
curl -sS -X POST https://studylog-eo0.pages.dev/api/suggestions \
  -H 'content-type: application/json' \
  -d '{"title":"测试"}'

# ③ 用真浏览器打开公开页，真的提交一本 → 成功才叫通了
```

### 怎么读这两条的结果（关键）

**403 才算「Secret 真的生效了」。** 如果 ① 返回的是别的，就是没生效：

| 返回 | 说明 |
|---|---|
| `403 人机校验没通过` | ✅ 对的，说明 `TURNSTILE_SECRET` 注入成功 |
| `500 荐读表还没建…` | ❌ 没生效 —— 没配 secret 时函数静默放行，请求一路往下走到了写库那步 |
| `200 ok` | ❌ 没生效，而且**真的往库里写了一条**。去写作台把这条「测试」删掉 |

看到 ②③ 就说明是**「配漏了」而不是「代码错了」** —— 省掉一大圈排查。

---

## 6.5 万一它就是没生效

排查顺序（从最可能到最不可能）：

1. 环境变量名是不是**一字不差**的 `TURNSTILE_SECRET`
2. **改完环境变量有没有重新部署** —— 不需要动代码，Retry deployment 就够
3. 变量的**类型**是不是 Secret。选了别的类型本身不影响读取，但容易在复制时带进空白字符
4. 在 Pages 的**实时日志**里看有没有 `turnstile failed` —— 有的话把 `error-codes` 打出来对第 7 节的表

---

## 7. 常见坑（按踩到的概率排序）

1. **提交失败后就再也提交不上去了。** 最常见。原因：token 一次性，失败后用掉的那个已经废了。
   解法就是 4.3 的第 ③ 步 `turnstileReset` —— 忘了它，用户第一次输错书名之后就一直失败。
2. **填了十分钟才提交，报校验失败。** token 300 秒过期。Managed 模式下 widget 会自己刷新，
   但如果你的表单是「打开就画好了、用户一直没动」，最好在用户第一次输入时再 `turnstileReset` 一次。
3. **控件就是不显示 / 显示成一团错误。** 两个原因：hostname 没填对（当前域名不在白名单），
   或者 `TS_KEY` 还是那个没替换的占位符 —— 占位符不是合法 sitekey，控件会直接渲染失败。
   所以「先把 key 替换掉」是这一步的前置动作。
4. **本地能过、线上不行（或反过来）。** sitekey 与 secret 不成对，或者线上环境变量没生效
   （忘了重新部署）。
5. **自动化测试全挂。** Turnstile 会识别 headless 浏览器。测试环境换测试 key。
6. **`error-codes` 值对照**（在部署日志里打出来看）：

   | error-code | 意思 |
   |---|---|
   | `missing-input-secret` / `invalid-input-secret` | 环境变量没配上或值不对 |
   | `missing-input-response` / `invalid-input-response` | 前端没传 token，或 token 是假的 |
   | `timeout-or-duplicate` | token 过期了，或者已经被用过了（→ 坑 1） |
   | `bad-request` / `internal-error` | 请求格式问题 / Cloudflare 自己出错 |

7. **别给写作台加。** 已说过，再说一遍 —— 那是你自己在用的地方。

---

## 8. 做完之后，防护这张图长什么样

```
访客提交
   │
   ├─ 蜜罐命中？          → 假装成功，不写库（不给机器人反馈）
   ├─ 人机校验通过？      → 不过就 403          ← 本次新增
   ├─ 内容合法？（长度 / 链接）
   ├─ 被拉黑？            → 403
   └─ 超限流？            → 429
         │
         └─ 写库
```

一共五层，每一层单独看都能被绕，叠起来才拦得住。

---

## 参考

- Turnstile 总览：<https://developers.cloudflare.com/turnstile/get-started/>
- 服务端校验（Siteverify）：<https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
- 测试 key：<https://developers.cloudflare.com/turnstile/troubleshooting/testing/>
- 免费版额度：<https://developers.cloudflare.com/turnstile/plans/>
