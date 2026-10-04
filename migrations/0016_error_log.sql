-- What went wrong, kept for the studio's «Diagnose» page: every error an item records (failed, retried,
-- deferred) and failures outside items (transitions, the queue). Pruned after 30 days.
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  item_id TEXT,
  show_id TEXT,
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS error_log_owner ON error_log (owner_id, id);
