# 部署手册 · 把 StudyLog 放到网上

这份手册带你从零把网站部署到 Cloudflare，全程用网页操作，不用命令行。

做完之后你会得到两个网址：

| 网址 | 谁看 | 能做什么 |
|------|------|----------|
| `https://你的项目.pages.dev/` | 只有你 | 完整写作台（写日记、学习打卡、目标管理） |
| `https://你的项目.pages.dev/view` | 朋友 | 只读看你的日记，不能改任何东西 |

---

## 先理解一下为什么需要这些步骤

改造前的网站是「纯本地」的：日记存在你自己浏览器的 localStorage 里。朋友打开同一个网址，代码一模一样，但他们浏览器里的那个抽屉是空的 —— 所以他们什么也看不到。

改造后变成这样：

```
你（写作台）  ──发布──▶  Cloudflare D1 数据库  ◀──读取──  朋友（公开只读页）
```

- **能写的人**：只有拿着 `ADMIN_TOKEN` 这个暗号的你。
- **只能读的人**：所有访问 `/view` 的访客。他们页面上根本不存在编辑按钮，就算自己改网页代码，服务器也会拒绝他们的写入请求。

> 关键点：**权限判断在服务器上，不在网页上。** 网页上的代码人人可见，靠它拦人等于没拦。真正的关卡是 `/api/admin/diary` 这个接口，它会检查暗号。

---

## 准备工作

你需要：

1. 一个 **Cloudflare 账号** —— [dash.cloudflare.com](https://dash.cloudflare.com) 用邮箱免费注册，不需要买域名，不需要绑信用卡。
2. 代码已经推到 GitHub。仓库地址：`https://github.com/V2tin19/StudyLog`

---

## 第一步：在 Cloudflare 建数据库（D1）

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 左侧菜单找 **「存储和数据库」**（Storage & Databases）→ **「D1 SQL 数据库」**
3. 点 **「创建数据库」**，名字填 `studylog-db`，创建
4. 进入这个数据库，点 **「Console」**（控制台）标签
5. 打开项目里的 `schema.sql`。这个文件**一行就是一条完整语句、不含任何注释**（这是故意的，见下面说明）
6. 先尝试**整段复制粘贴**到输入框，点 **「执行 / Execute」**

成功的标志：最后会返回一张表名列表，里面有 `diary` 和 `site_meta`。

> 这一步可以重复执行，不会报错也不会删掉已有日记。

### 如果报错「Requests without any query are not supported」

意思是**控制台没收到任何可执行的语句**，SQL 本身没问题。原因是这个输入框很有可能是**单行输入**式的 —— 多行文本粘进去只会保留第一行；而如果第一行恰好是注释（`--` 开头），服务器就收到一个空查询。

`schema.sql` 已经改成防这个坑的格式了。如果整段粘贴仍然不行，就**一条一条粘、一条一条执行**，顺序照抄即可：

```sql
CREATE TABLE IF NOT EXISTS diary (date TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', mood TEXT NOT NULL DEFAULT '', review TEXT NOT NULL DEFAULT '', images TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
```

```sql
CREATE INDEX IF NOT EXISTS idx_diary_order ON diary(pinned DESC, date DESC);
```

```sql
CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
```

```sql
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('site_title', '我的学习记录');
```

```sql
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('owner_name', '果冻');
```

```sql
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('announcement', '');
```

**自查**，看看表建好没：

```sql
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
```

应该返回两行：`diary`、`site_meta`（外加 SQLite 自己的内部表，属正常）。

---

## 第二步：创建 Pages 项目，接上 GitHub

1. 左侧菜单 → **「计算」**（Compute / Workers & Pages）→ **「Pages」** 标签
2. 点 **「创建应用程序」** → **「连接到 Git」**
3. 授权 GitHub，选择仓库 `V2tin19/StudyLog`，分支选 `main`
4. 构建设置填：
   - **框架预设**：`None`（无）
   - **构建命令**：**留空**
   - **构建输出目录**：`/`
5. 点 **「保存并部署」**

第一次部署会失败或页面报错 —— **这是正常的**，因为数据库还没绑定。继续往下做。

部署完成后你会拿到一个 `xxxxx.pages.dev` 的网址。

---

## 第三步：把数据库绑到项目上

1. 进入刚创建的 Pages 项目 → **「设置」**（Settings）→ **「函数」**（Functions）
2. 找到 **「D1 数据库绑定」** → 点 **「添加绑定」**
3. 变量名称必须填 **`DB`**（大写，不能改），数据库选 `studylog-db`
4. 保存

> 变量名为什么必须是 `DB`？因为后端代码里是用 `env.DB` 取数据库的。名字对不上就取不到。

---

## 第四步：设置你的写作暗号

1. 还在 Pages 项目的 **「设置」** → **「环境变量和密钥」**（Variables and Secrets）
2. 点 **「添加」**：
   - 名称：`ADMIN_TOKEN`
   - 值：一串只有你知道的随机长字符串
   - 类型：选 **「密钥 / Secret」**（加了之后界面上就看不到明文了）
3. 保存

**怎么生成一串够安全的暗号？** 打开任意网页 → 按 `F12` → 切到 `Console` 标签 → 粘贴下面这行回车：

```js
crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-','')
```

会得到一串 64 位的随机字符，类似 `a3f9c1d8...`。复制它，粘贴到上面「值」的位置。

> ⚠️ 这串暗号等于你家钥匙。**不要**写进代码、不要提交到 GitHub、不要发给朋友。忘记的话可以在 Cloudflare 后台重设，然后在写作台重新填一次。

---

## 第五步：重新部署，让配置生效

**改了 D1 绑定和环境变量后，必须重新部署一次才会生效。**

1. 进入 Pages 项目 → **「部署」**（Deployments）
2. 找到最新一次部署，点右侧 **「···」** → **「重试部署」**（Retry deployment）

等它跑完（几十秒）。

---

## 第六步：验证是否成功

打开 `https://你的项目.pages.dev/view`

- 看到「还没有记录」→ **成功**，数据库通了，只是你还没写日记
- 看到「没能读到记录：数据库未绑定…」→ 回到第三步检查绑定，变量名必须是 `DB`，然后重新部署

---

## 第七步：写第一篇并发布

1. 打开 `https://你的项目.pages.dev/` （**不带 `/view`**，这是你的写作台）
2. 左侧「日记」→「写日记」→ 写点东西 → 保存
3. 左侧「设置」→ 找到 **「云端同步」** 卡片
4. 在「管理令牌」里粘贴第四步那串暗号
5. 点 **「测试连接」** —— 看到「连接成功」说明暗号对了
6. 点 **「发布到云端」** —— 看到「发布完成：已写入 N 篇」

现在刷新 `https://你的项目.pages.dev/view`，朋友就能看到了。

> 令牌会存在你自己浏览器的 localStorage 里，下次打开设置页会自动填上，不用每次粘贴。

---

## 以后每次写日记的流程

```
写作台写日记  →  设置页点「发布到云端」  →  朋友刷新就能看到
```

就这样，只有一步额外操作。

**注意**：本地的日记是「原件」，云端是「发布出去的副本」。如果你删掉本地某篇日记，云端那份**不会**自动消失，需要手动处理（这个以后会做成自动同步）。

---

## 常见问题

**执行 `schema.sql` 时报「Requests without any query are not supported」**
控制台没收到可执行语句，不是 SQL 写错了。原因通常是输入框只保留了粘贴内容的第一行，而第一行是注释。解决办法见第一步下面的说明：改成一**条一条粘、一条一条执行**。

**执行 `schema.sql` 时只成功了一部分（比如只有 diary 表）**
同一个原因 —— 多行内容被截断了。把第一步里六条语句逐条重新执行一遍即可，`IF NOT EXISTS` 和 `INSERT OR IGNORE` 保证重复执行不会出问题。

**发布时提示「服务端还没有设置 ADMIN_TOKEN 环境变量」**
环境变量没配，或者配了但没重新部署。回到第四步 + 第五步。

**发布时提示「令牌不正确，无权操作」**
你在「管理令牌」框里填的暗号和 Cloudflare 上配的不一致。重新从 Cloudflare 复制一次（注意别带空格）。

**公开页显示「没能读到记录：数据库未绑定」**
第三步的绑定没做或变量名不是 `DB`。改完记得重新部署。

**公开页显示「还没读到记录」，但我明明发布了**
- 检查一下发布时是不是提示了成功
- 检查日记正文是不是空的（空内容的记录不会发布）
- 浏览器缓存，强制刷新试试（`Ctrl + F5`）

**图片为什么在公开页看不到？**
现阶段本地图片是存成 base64 塞在浏览器里的，没法直接同步到数据库（会撑爆）。等接入 Cloudflare R2 对象存储后就能同步了 —— 这是后面的阶段任务。发布时如果跳过了图片，会明确告诉你跳过了几张，不会静默丢失。

**朋友能不能偷偷改我的日记？**
不能。公开页没有任何写入入口；就算他懂技术、自己伪造请求打到 `/api/admin/diary`，没有那串 64 位暗号，服务器会直接回 `401 令牌不正确`。这一点已实测验证。

**能不能绑自己的域名？**
可以。Pages 项目 → 「自定义域」→ 添加你的域名，按提示改 DNS 即可。用免费的 `xxx.pages.dev` 也完全够用。

---

## 后续阶段（还没做）

| 阶段 | 内容 | 解决什么 |
|------|------|----------|
| 阶段二 | 上 Cloudflare Access，管理入口换成邮箱登录 | 不用再手输令牌，且只有你的邮箱能进 |
| 阶段三 | 评论系统 + Turnstile 防刷 + 你的评论管理面板 | 朋友能留言，你能删 |
| 阶段四 | 图片走 R2 对象存储 | 日记配图能正常显示 |
| 阶段五 | 学习/目标/日程数据也同步 | 公开页能展示更多维度 |

---

## 本次改造动了哪些文件

**新增**

| 文件 | 作用 |
|------|------|
| `schema.sql` | 数据库建表语句（**一行一条、无注释**，为兼容 D1 控制台的输入框格式） |
| `view.html` | 公开只读页 |
| `js/public-site.js` | 公开页的渲染逻辑 |
| `js/modules/cloud.js` | 写作台里的「发布到云端」模块 |
| `functions/api/_shared.js` | 后端公共工具（转数据格式、校验日期、安全比对令牌） |
| `functions/api/diary/index.js` | `GET /api/diary` 公开读列表 |
| `functions/api/diary/[date].js` | `GET /api/diary/:date` 公开读单篇 |
| `functions/api/admin/diary.js` | 写入接口，带令牌校验（唯一真正的关卡） |

**修改**

| 文件 | 改了什么 |
|------|----------|
| `index.html` | 多加载一个 `cloud.js` |
| `js/modules/settings.js` | 设置页新增「云端同步」卡片；关于本站的隐私说明改成准确表述 |
| `robots.txt` | 去掉假域名，说明公开页不被搜索引擎收录 |

**没动**：`css/style.css`、`js/app.js`、`js/modules/diary.js` 等其他模块 —— 你的写作体验和本地数据完全没受影响。
