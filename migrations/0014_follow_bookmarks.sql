-- Dranbleiben: topics the listener follows; the radio checks them daily and reports only what is new.
CREATE TABLE IF NOT EXISTS followed_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  created_at TEXT NOT NULL,
  checked_at TEXT,
  reported_at TEXT,
  known TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS followed_topics_owner ON followed_topics (owner_id, id);

-- Merken: items kept on a reading list, with title and sources copied (they outlive the item).
CREATE TABLE IF NOT EXISTS bookmarks (
  owner_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  show_name TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, item_id)
);
