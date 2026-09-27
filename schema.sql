CREATE TABLE IF NOT EXISTS diary (date TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', mood TEXT NOT NULL DEFAULT '', review TEXT NOT NULL DEFAULT '', images TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_diary_order ON diary(pinned DESC, date DESC);
CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('site_title', '我的学习记录');
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('owner_name', '果冻');
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('announcement', '');
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
