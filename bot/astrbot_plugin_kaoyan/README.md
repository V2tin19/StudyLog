# astrbot_plugin_kaoyan · AstrBot 考研自习助手插件

把「考研408备考助手」装进你已有的 AstrBot：**同一个 QQ 号、同一个 NapCat、零新进程**。
意图没命中时插件直接沉默，消息照常走 AstrBot 原有管线（人格/其他插件），零干扰。

## 安装

1. 把本目录整个复制到 AstrBot 的 `data/plugins/astrbot_plugin_kaoyan/`
2. 重启 AstrBot（或 WebUI 插件页重载）
3. WebUI → 插件 → 考研自习助手 → 填配置：
   - `master_qq`：你的 QQ 号
   - `site_api_base` / `admin_token`：StudyLog 站点地址 + ADMIN_TOKEN
   - `llm_api_base` / `llm_api_key` / `llm_model`：OpenAI 兼容 LLM
4. QQ 私聊 bot：「帮助」开始用

依赖：`aiohttp`、`APScheduler`（AstrBot 主 venv 已自带）。

## 与独立 bot 版（bot/ 目录）的关系

| | 独立 bot | 本插件 |
|---|---|---|
| QQ 接入 | 自带 NapCat WS 客户端 | 复用 AstrBot 的连接 |
| 适用 | 单独一个 bot 号 | **共用现有 AstrBot 号**（本服务器现状） |
| 定时任务 | 进程内轮询 | AstrBot 的 cron_manager |

两版共用 `nlu.py / planner.py / llm.py / cfstore.py`（纯逻辑，插件内是副本，
改动请同步两边或以 bot/ 为准再复制）。

## 不抢话机制

- 装载的正则粗筛命中的消息才进路由；路由再细判，**没命中考研意图就 return 不产出结果**，
  AstrBot 管线继续（消息仍会被人格 LLM 等正常处理）。
- 命中并回复后调用 `event.stop_event()`，人格不会重复接话。
- 群聊只在白名单群 + @bot 时响应，且关闭「状态反馈重排」这类模糊意图（防止抢走日常闲聊）。
