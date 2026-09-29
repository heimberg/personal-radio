-- Why a spoken item was rated down ("too long", "boring", ...); fed back to the writer and the jury.
ALTER TABLE feedback_events ADD COLUMN reason TEXT;

-- Jury marks survive the timeline cleanup, for the quality trend in the Redaktion settings.
CREATE TABLE IF NOT EXISTS quality_log (
  owner_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  show_id TEXT NOT NULL,
  overall REAL NOT NULL CHECK (overall >= 1 AND overall <= 5),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, item_id)
);
CREATE INDEX IF NOT EXISTS quality_log_owner_time ON quality_log (owner_id, created_at);

-- When the owner changed the editorial agents, so the trend shows what a change did.
CREATE TABLE IF NOT EXISTS agent_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  agents TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_changes_owner ON agent_changes (owner_id, changed_at);

-- Provider calls per UTC day and model (the station has one owner; providers have no owner context).
CREATE TABLE IF NOT EXISTS model_usage (
  utc_day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (utc_day, provider, model)
);
