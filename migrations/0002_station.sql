-- Station configuration is one validated JSON document per owner; edited as a whole in the cockpit.
CREATE TABLE IF NOT EXISTS station_config (
  owner_id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The program: planned by the cron planner, produced by the queue consumer, consumed by the players.
CREATE TABLE IF NOT EXISTS timeline_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  show_id TEXT NOT NULL,
  planned_at TEXT NOT NULL,
  estimated_minutes REAL NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned', 'voicing', 'ready', 'played', 'skipped', 'failed', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  script_json TEXT,
  sources_json TEXT,
  verification TEXT,
  audio_key TEXT,
  content_type TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, seq)
);
CREATE INDEX IF NOT EXISTS timeline_items_owner_state ON timeline_items (owner_id, state, seq);

CREATE TABLE IF NOT EXISTS feedback_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  interests_json TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('like', 'dislike', 'skip', 'complete')),
  listened_ratio REAL NOT NULL CHECK (listened_ratio >= 0 AND listened_ratio <= 1),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_events_owner ON feedback_events (owner_id, id);

-- Memory: source articles already turned into a segment are not retold.
CREATE TABLE IF NOT EXISTS covered_sources (
  owner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  covered_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, url)
);

-- Last time the owner opened the program; the cron only plans new content for an active listener.
CREATE TABLE IF NOT EXISTS station_activity (
  owner_id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL
);
