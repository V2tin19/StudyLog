# pusher —— 助手的「时钟 + 喇叭」

服务器上的小守护进程。Cloudflare Functions 是大脑（LLM、排期、数据都在那边），
pusher 只做两件事：

1. **踩点触发**：到点 POST 云端 `/api/admin/agent/cron/{kind}` 生成晨报/午间/晚间/周报，
   内容进通知队列（agent_outbox）。
2. **发 QQ**：每 30s 轮询 `/api/admin/agent/outbox`，把 `channel=qq|all` 且未发送的
   条目经 NapCat 发给 master_qq，发完标 sent。网页的铃铛读同一队列，两条通道天然一致。

## 部署（服务器，与 NapCat 同机）

```bash
pip install aiohttp
cp config.example.json config.json
chmod 600 config.json
vim config.json        # 填 cf_base / admin_token / master_qq / NapCat 地址
python3 pusher.py      # 前台试跑，看到「pusher 启动」即正常
```

systemd 常驻（`/etc/systemd/system/agent-pusher.service`）：

```ini
[Unit]
Description=StudyLog agent pusher (cron triggers + QQ notify)
After=network-online.target

[Service]
WorkingDirectory=/root/agent-pusher
ExecStart=/usr/bin/python3 /root/agent-pusher/pusher.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now agent-pusher
journalctl -u agent-pusher -f
```

## NapCat 连接方式（二选一）

| 方式 | config 字段 | NapCat 侧 |
|---|---|---|
| 正向 WS（推荐，kaoyan bot 同款） | `napcat_ws: "ws://127.0.0.1:3001"` | NapCat 配置里开「WebSocket 服务器」，端口 3001（或复用 kaoyan 时期开好的） |
| HTTP | `napcat_http: "http://127.0.0.1:3000"` | NapCat 开「HTTP 服务器」，端口 3000 |

- 有 access token 就填 `napcat_token`。
- ⚠️ **同机勿开第二个 QQ 壳**（会断 NapCat 快速登录）；本进程只是 WS/HTTP 客户端，不算壳。
- AstrBot 走的是反向 WS（6200），与这里的正向 WS 客户端互不干扰。

## 定时

`config.json` 的 `push_times`（北京时间）：晨报 07:30 / 午间 12:30 / 晚间 21:30 /
周报周日 21:00（`weekly_day: 6`，python weekday） / 习惯聚合 23:50。
改了重启生效。防重是进程内存 fired-map（date+kind），重启当天最多多发一条。

## 验证

```bash
# 干跑晨报（不入队，直接看文案）
curl -s -X POST "https://<你的域名>/api/admin/agent/cron/brief?dry=1" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
# 手动入队一条，看 QQ 是否收到
curl -s -X POST "https://<你的域名>/api/admin/agent/outbox" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"kind":"note","text":"pusher 测试","channel":"qq"}'
```
