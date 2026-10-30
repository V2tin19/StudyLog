# 考研 QQ Bot 部署指南

一个挂在 QQ 上的考研备考助手：自然语言记录学习、AI 维护时段计划、状态不好随时调、每周自动总结。

```
手机QQ ──NapCat(服务器常驻)──WebSocket──> 考研Bot(本项目, Python)
                                             │
                     ┌───────────────────────┤
                     ▼                       ▼
               LLM API(可配置)         Cloudflare Pages(本仓库部署的站点)
               语义抽取/排计划/周报       /api/admin/kaoyan-plan    计划读写
                                        /api/admin/study-session  学习记录/打卡
                                             │
                                             ▼
                                     D1: doc.kaoyan + doc.study
                                     （写作台「考研」页读同一份数据）
```

## 它能干什么（QQ 里直接说人话）

| 你说 | 它做 |
|---|---|
| 「今天下午学了2小时数据结构，刷了王道课后题」 | 记到**今天**的学习台账（网页同步可见） |
| 「昨天晚上背了1小时单词」 | 记到昨天 |
| 「今天安排」「现在该学什么」 | 返回今天的时段表，标注当前时段 |
| 「今天状态不好」 | AI 按状态重排今天（降量、加休息），写回云端 |
| 「重排本周计划」 | AI 生成未来 7 天细到时段的计划 |
| 「本周总结」 | 统计+健康分+AI 建议 |
| 「打卡」 / 「撤销」 | 补打卡 / 撤销刚才记的那条 |
| 「考试日期 2026-12-26」 | 设置倒计时 |

**日期铁律**：所有日期由代码按本地时区解析（`nlu.py`），LLM 只负责理解语义，绝不直接产出日期。当天的记当天，说「昨天」记昨天，「周四」解析到最近的过去周四，未来日期直接拒绝。这套逻辑有 47 个断言用例（`test_core.py`）。

---

## 部署步骤

### 0. 前置

- 一台 Linux 服务器（1核1G 就够，CentOS/Debian/Ubuntu 都行）或常开的自己电脑
- 本仓库已部署到 Cloudflare Pages，且配置了环境变量 `ADMIN_TOKEN`（见根目录 DEPLOY.md）
- 一个 LLM API Key（OpenAI 兼容接口即可：GLM / DeepSeek / Qwen……）
- 一个用来当 bot 的 QQ 号（建议小号）

### 1. 装 NapCat（QQ 协议端）

推荐 Docker 方式：

```bash
docker run -d --name napcat \
  -e ACCOUNT=你的bot的QQ号 \
  -e WEBUI_TOKEN=随意一个字符串 \
  -v /opt/napcat/config:/app/napcat/config \
  -p 6099:6099 \
  mlikiowa/napcat-docker:latest
```

然后打开 `http://服务器IP:6099` 进 WebUI 扫码登录，并在网络配置里**启用「WebSocket 服务器」**：

- 监听 `127.0.0.1`（只监听本机，安全）
- 端口 `3001`
- 不用设 token（只监听本机时可以留空；设了的话填到 bot 配置里对应）

详细选项参考 NapCat 官方文档（github.com/NapNeko/NapCat-Docker）。

> Windows 也可以跑：下载 NapCat.Shell 挂 QQ，同样开一个正向 WS 服务即可。

### 2. 部署本项目 bot

```bash
# 服务器上
git clone <本仓库> /opt/studylog-bot && cd /opt/studylog-bot/bot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp config.example.json config.json
vim config.json
```

`config.json` 必填项：

```jsonc
{
  "napcat": { "ws_url": "ws://127.0.0.1:3001", "access_token": "" },
  "master_qq": [你的QQ号],              // 只有这些人能用 bot
  "groups": [],                          // 想在群里用就填群号（仍需@bot）
  "site": {
    "api_base": "https://你的站点.pages.dev",
    "admin_token": "与 Cloudflare 的 ADMIN_TOKEN 一致"
  },
  "llm": {
    "api_base": "https://open.bigmodel.cn/api/paas/v4",  // GLM 示例
    "api_key": "sk-...",
    "model": "glm-4-flash",
    "json_mode": true
  },
  "timezone": "Asia/Shanghai",
  "push": { "enabled": true, "daily_plan_time": "07:30",
            "weekly_report_day": "sunday", "weekly_report_time": "21:00" },
  "study": { "weekly_target_hours": 49 }
}
```

先手动跑一次看日志：

```bash
python main.py
# 看到「已连上 NapCat」即成功，去 QQ 私聊它「帮助」
```

### 3. 设成常驻服务（systemd）

```bash
sudo tee /etc/systemd/system/studylog-bot.service <<'EOF'
[Unit]
Description=StudyLog Kaoyan QQ Bot
After=network-online.target docker.service
Wants=network-online.target

[Service]
WorkingDirectory=/opt/studylog-bot/bot
ExecStart=/opt/studylog-bot/bot/.venv/bin/python main.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now studylog-bot
journalctl -u studylog-bot -f        # 看日志
```

### 4. 本地自测（不部署也能跑核心逻辑）

```bash
cd bot && python test_core.py
```

---

## 给外部 AI 的接口（「留一个接口让 LLM 直接对接修改」）

以下接口都走 `Authorization: Bearer <ADMIN_TOKEN>`，就是给任意 AI agent（clawbot/OpenClaw、ZCode、自建 agent…）的官方修改入口：

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/admin/kaoyan-plan` | GET | 读计划 JSON（没有则返回骨架） |
| `/api/admin/kaoyan-plan` | PUT | 整包写计划，服务端校验时段/日期/重叠，坏数据进不来 |
| `/api/admin/study-session?days=30` | GET | 最近学习记录 + 打卡 |
| `/api/admin/study-session` | POST | `{session}` 或 `{sessions:[...]}` 增量追加（服务端合并，防整包覆盖）；`{checkin:"YYYY-MM-DD"}` 补打卡 |
| `/api/admin/study-session?id=xxx` | DELETE | 撤销一条 |
| `/api/diary` | GET | 公开日记（含 mood 字段，周报的数据源之一） |

计划 JSON 结构（`PUT` 的 body）：

```jsonc
{
  "plan": {
    "examDate": "2026-12-26",
    "template": { "1": [ {"start":"08:30","end":"11:30","subject":"数学"} ] },  // '0'=周日
    "days":    { "2026-11-01": { "slots": [...], "note": "冲刺周" } },          // 覆盖模板
    "任意扩展字段": "AI 可自由添加（阶段目标等）"
  }
}
```

slot 结构：`{"start":"HH:MM","end":"HH:MM","subject":"科目","topic":"具体内容","status":"todo|done"}`（`status` 可选，给 AI 做进度标记用）。

---

## 已知边界（改代码前读）

1. **整包同步的覆盖窗口**：网页端 `doc.study` 是整包覆盖式同步（见 js/modules/sync.js）。bot 走服务端合并接口写入，但如果网页在**没有重新拉取**的情况下又推送了旧包，bot 刚记的记录会被冲掉。单用户场景概率很低；养成习惯：bot 记录后，网页刷新一下再编辑。
2. **时区**：bot 用 `config.timezone`（默认北京时间）解析日期；CF 端 `study-session.js` 固定按北京时间算「今天」。两边一致，用户在中国就没事。
3. **撤销范围**：bot 只能撤销它本次运行期间记的条目（内存栈），重启后不能。
4. **LLM 失联降级**：录入有正则快车道，常见句式不需要 LLM 也能记；重排/周报必须 LLM。
5. QQ 协议端属于第三方实现（NapCat），账号存在理论风险，**建议用小号**。
