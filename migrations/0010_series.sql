-- Series: a subject over several episodes; episodes are timeline items with show_id '_series:<id>'.
CREATE TABLE IF NOT EXISTS series (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wissen', 'geschichte')),
  episodes_json TEXT NOT NULL,
  recaps_json TEXT NOT NULL DEFAULT '[]',
  scheduled INTEGER NOT NULL DEFAULT 0 CHECK (scheduled >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'done', 'stopped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);
