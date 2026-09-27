CREATE TABLE IF NOT EXISTS diary (date TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', mood TEXT NOT NULL DEFAULT '', review TEXT NOT NULL DEFAULT '', images TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_diary_order ON diary(pinned DESC, date DESC);
CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS doc (key TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('site_title', '我的学习记录');
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
  hidden     INTEGER NOT NULL DEFAULT 0
);
-- 公开读（按 scope+target 取列表）和 counts 聚合都吃这个索引
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(scope, target, hidden, id);
-- 限流查询：同 IP 最近一分钟
CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments(ip_hash, created_at);

-- 拉黑名单。站主在写作台点「拉黑」就往这里写一条，之后同一个 IP 发不出留言。
CREATE TABLE IF NOT EXISTS comment_blocklist (
  ip_hash    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
