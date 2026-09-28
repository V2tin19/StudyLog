CREATE TABLE IF NOT EXISTS diary (date TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', mood TEXT NOT NULL DEFAULT '', review TEXT NOT NULL DEFAULT '', images TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_diary_order ON diary(pinned DESC, date DESC);
CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS doc (key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('site_title', '学习日报');
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('owner_name', '果冻');
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('announcement', '');

-- ============================================================
-- 留言（唯一一个访客能写的功能）
--
-- scope + target 两种用法：
--   scope='diary' + target='2026-09-27'  → 挂在那一天的日记下面
--   scope='board' + target=''            → 独立留言簿
--
-- hidden 是软删除：站主点「隐藏」只是不再公开显示，记录还留着
-- （万一删错了能恢复，也能看出是谁捣乱）。
-- ip_hash 存的是加盐 SHA-256，不是 IP 原文 —— 只用来限流和拉黑。
-- ============================================================
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT    NOT NULL DEFAULT 'diary',
  target     TEXT    NOT NULL DEFAULT '',
  name       TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  ip_hash    TEXT    NOT NULL DEFAULT '',
  hidden     INTEGER NOT NULL DEFAULT 0,
  reply      TEXT    NOT NULL DEFAULT '',
  reply_at   TEXT    NOT NULL DEFAULT '',
  location   TEXT    NOT NULL DEFAULT ''
);
-- 已有老表无痛升级语句（在 D1 Console 执行）：
-- ALTER TABLE comments ADD COLUMN reply TEXT NOT NULL DEFAULT '';
-- ALTER TABLE comments ADD COLUMN reply_at TEXT NOT NULL DEFAULT '';
-- ALTER TABLE comments ADD COLUMN location TEXT NOT NULL DEFAULT '';
-- 公开读（按 scope+target 取列表）和 counts 聚合都吃这个索引
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(scope, target, hidden, id);
-- 限流查询：同 IP 最近一分钟
CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments(ip_hash, created_at);

-- 拉黑名单。站主在写作台点「拉黑」就往这里写一条。
-- 注意：留言和书目荐读**共用**这张表 —— 被拉黑的人两个口子都发不出东西。
-- 名字里带 comment 是历史原因（最初只有留言在用），现在没改名，
-- 因为改名要让已经建好表的环境重跑 SQL，收益只是名字好看。
CREATE TABLE IF NOT EXISTS comment_blocklist (
  ip_hash    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- ============================================================
-- 书目荐读（第二个访客能写的功能）
--
-- 访客推荐一本书 → 进待审队列 → 站主在写作台通过 → 自动进站主的书单。
-- status：pending 待审 / approved 已通过 / rejected 不要
-- imported_at：这本书「已经搬进书单」的时间。
--   为什么要单独一个字段，而不是靠「书名是否已在书单里」判断：
--   书名会重名、会被改名，靠字符串比对迟早误判。写死一个时间戳最可靠，
--   而且这样才有兜底 —— 通过之后写作台要是没开着，下次打开能补收，不会漏。
-- ip_hash 同样是加盐 SHA-256，跟留言共用一张黑名单。
-- ============================================================
CREATE TABLE IF NOT EXISTS book_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  author      TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',
  name        TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  TEXT    NOT NULL,
  decided_at  TEXT    NOT NULL DEFAULT '',
  imported_at TEXT    NOT NULL DEFAULT '',
  ip_hash     TEXT    NOT NULL DEFAULT ''
);
-- 公开页只读 approved（按 id 倒序翻页）
CREATE INDEX IF NOT EXISTS idx_suggest_status ON book_suggestions(status, id);
-- 限流：同 IP 最近一分钟
CREATE INDEX IF NOT EXISTS idx_suggest_ip ON book_suggestions(ip_hash, created_at);

-- ============================================================
-- 目标推荐（第三个访客能写的功能）
--
-- 跟上面的书目荐读是同一套流程：访客推荐 → 待审 → 通过 → 自动进目标清单。
-- 字段**刻意跟 book_suggestions 一模一样** —— 目标没有「作者」这一栏，
-- author 恒为空串。用一列换后端「一个 if 分支都不用写」，很划算。
-- 后端的公用实现在 functions/api/_suggest.js，前端在 js/modules/suggestions.js。
-- ============================================================
CREATE TABLE IF NOT EXISTS goal_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  author      TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',
  name        TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  TEXT    NOT NULL,
  decided_at  TEXT    NOT NULL DEFAULT '',
  imported_at TEXT    NOT NULL DEFAULT '',
  ip_hash     TEXT    NOT NULL DEFAULT ''
);
-- 公开页只读 approved（按 id 倒序）
CREATE INDEX IF NOT EXISTS idx_gsuggest_status ON goal_suggestions(status, id);
-- 限流：同 IP 最近一分钟
CREATE INDEX IF NOT EXISTS idx_gsuggest_ip ON goal_suggestions(ip_hash, created_at);

SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
