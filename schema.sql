-- ============================================
-- StudyLog · Cloudflare D1 表结构
-- 用法：Cloudflare 控制台 → 存储和数据库 → D1 → 选你的库 → Console
--       把下面全部内容粘进去，点 Execute
-- 可以重复执行，不会报错，也不会删已有数据。
-- ============================================

-- 日记表：一天一条，以日期为主键
CREATE TABLE IF NOT EXISTS diary (
  date       TEXT PRIMARY KEY,              -- 日期 YYYY-MM-DD，全局唯一
  content    TEXT NOT NULL DEFAULT '',      -- 日记正文
  mood       TEXT NOT NULL DEFAULT '',      -- 心情标签：happy/tired/anxious...
  review     TEXT NOT NULL DEFAULT '',      -- 复盘内容
  images     TEXT NOT NULL DEFAULT '[]',    -- 图片地址数组，JSON 字符串
  pinned     INTEGER NOT NULL DEFAULT 0,    -- 是否置顶：0 否 / 1 是
  created_at TEXT NOT NULL DEFAULT '',      -- 创建时间 ISO 字符串
  updated_at TEXT NOT NULL DEFAULT ''       -- 最后修改时间 ISO 字符串
);

-- 按 置顶 + 日期倒序 查列表时走的索引
CREATE INDEX IF NOT EXISTS idx_diary_order ON diary(pinned DESC, date DESC);

-- 站点公开信息：给公开页显示标题、公告用（后面做设置面板时会写进去）
CREATE TABLE IF NOT EXISTS site_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- 预置两条默认配置（已存在则忽略）
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('site_title', '我的学习记录');
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('owner_name', '果冻');
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('announcement', '');

-- ============================================
-- 自查：执行完跑这句，应该返回 2 行（diary / site_meta）
-- SELECT name FROM sqlite_master WHERE type='table';
-- ============================================
