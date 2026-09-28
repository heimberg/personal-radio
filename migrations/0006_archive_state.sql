-- Archive: produced items that left the program unheard become 'archived' instead of 'expired' and stay
-- playable until their audio is released. SQLite cannot change a CHECK constraint, so the table is rebuilt.
CREATE TABLE timeline_items_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  show_id TEXT NOT NULL,
  planned_at TEXT NOT NULL,
  estimated_minutes REAL NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned', 'voicing', 'ready', 'played', 'skipped', 'archived', 'failed', 'expired')),
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
  research_json TEXT,
  UNIQUE (owner_id, seq)
);
INSERT INTO timeline_items_new (id, owner_id, seq, show_id, planned_at, estimated_minutes, state, attempts, lease_until, script_json,
  sources_json, verification, audio_key, content_type, error, created_at, updated_at, research_json)
SELECT id, owner_id, seq, show_id, planned_at, estimated_minutes, state, attempts, lease_until, script_json,
  sources_json, verification, audio_key, content_type, error, created_at, updated_at, research_json FROM timeline_items;
DROP TABLE timeline_items;
ALTER TABLE timeline_items_new RENAME TO timeline_items;
CREATE INDEX IF NOT EXISTS timeline_items_owner_state ON timeline_items (owner_id, state, seq);
