# StudyLog · 个人学习每日汇报

> **“每天写一篇学习与生活日报给朋友看，附带专注时长统计，营造每日汇报的在场感。”**  
> 线上公开主页：[https://studylog-eo0.pages.dev/](https://studylog-eo0.pages.dev/)  
> 站主写作台入口：`/write`（需暗号解锁）

---

## 1. 这是什么

StudyLog 是一个极简主义的个人日报与公开分享站点：
- **给朋友看（公开页 `/`）**：按月按天浏览每日学习汇报、阅读书单、个人目标、公开日程；访客可以在留言簿留言，或给站长递一杯热咖啡打气。
- **给自己写（写作台 `/write`）**：带暗号门禁，支持日记写作、心情曲线、便签草稿、复盘模板、学习时长台账、访客留言与荐书审核。
- **数据与同步**：基于 Cloudflare Pages Functions + D1 (SQLite) 云端存储；同时深度支持 LocalStorage 离线兜底与增量合并，无网也能顺畅写作，联网自动对齐。

> 💡 **架构拆分说明**：原探索中的考研自然语言排期与 AI 智能体专项，已全面拆分为独立专属工程 **[Inchi (寸序)](https://github.com/V2tin19/Inchi)**。本仓库专注作为纯粹、高可靠的日报公开站与写作台。

---

## 2. 技术栈

| 层次 | 技术 | 说明 |
|---|---|---|
| **前端展现** | HTML5 + CSS3 + 原生 ES6+ JS | 零框架、零打包依赖、毫秒级首屏加载 |
| **视觉体系** | 柔和高雅双主题 | 亮色与暗色模式自适应，纯 SVG 轻量图表 |
| **云端存储** | Cloudflare D1 (SQLite) | 免费额度充足的边缘无服务器关系型数据库 |
| **后端接口** | Cloudflare Pages Functions | 边缘 Serverless 运行，保障写入令牌校验 |
| **离线能力** | LocalStorage + 冲突合并 | 写作台本地优先，断网照常写，联网自动推 |

---

## 3. 目录结构

```
StudyLog/
├── index.html              # 公开页入口（/）
├── write.html              # 站主写作台入口（/write）
├── schema.sql              # D1 数据库完整建表语句
├── robots.txt              # 爬虫策略（全站 noindex 保护隐私）
├── 6f79d00645e785a82e97.txt # 站点域名所有权校验令牌
├── docs/                   # 运维与接入文档
│   ├── DEPLOY.md           # Cloudflare Pages 部署手册
│   ├── TURNSTILE.md        # 人机验证接入说明
│   └── archive/            # 历史规划与备忘归档
│
├── css/
│   └── style.css           # 全局样式（双主题、响应式栅格）
│
├── js/
│   ├── app.js              # 写作台路由与模块调度
│   ├── public-site.js      # 公开页渲染引擎
│   ├── lock.js             # 写作台令牌门禁遮罩
│   └── modules/
│       ├── diary.js        # 日记正文、心情、便签
│       ├── study.js        # 学习记录、书籍、技能、打卡
│       ├── extras.js       # 日程表、目标清单
│       ├── dashboard.js    # 仪表盘统计与图表
│       ├── comments.js     # 留言管理（审核、隐藏、拉黑）
│       ├── suggestions.js  # 书目与目标推荐审核
│       ├── settings.js     # 备份导入导出、暗号管理
│       ├── storage.js      # 本地持久化抽象
│       ├── cloud.js        # 云端 API 客户端封装
│       └── sync.js         # 增量安全同步引擎
│
└── functions/api/          # Cloudflare Pages Functions
    ├── _shared.js          # 鉴权与通用工具
    ├── _suggest.js         # 荐书/荐目标公共工厂
    ├── diary/              # 公开只读日记 API
    ├── comments/           # 访客留言 API（带限流、蜜罐、黑名单）
    ├── suggestions/        # 访客荐书 API
    ├── goal-suggestions/   # 访客目标推荐 API
    └── admin/              # 需令牌校验的站长管理 API
        ├── diary.js        # 日记提交与删除
        ├── doc.js          # 展示型文档聚合（study/schedule/goals/focus）
        ├── comments.js     # 留言审核/回复/删除
        ├── suggestions.js  # 荐读处理
        └── blocklist.js    # 违规 IP 拉黑
```

---

## 4. 快速开始与部署

详细图文操作请见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

1. **创建 Cloudflare D1 数据库**，执行 `schema.sql` 完成数据表初始化；
2. **连接 Cloudflare Pages**：输出目录填 `/`，构建命令留空；
3. **绑定 D1 数据库**：变量名必须配置为 `DB`；
4. **设置环境变量**：配置 `ADMIN_TOKEN` 为你的写作通行暗号；
5. 在浏览器访问 `/write` 输入暗号解锁，开始记录你的第一篇学习日报。

---

## 5. 开源协议

[MIT License](LICENSE) (c) 2026 StudyLog Authors.
