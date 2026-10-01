-- Mitmachen: interactive stories (a choice at the end of each episode), stickers for an album, and questions
-- to the radio that the host answers in the next live transition.
ALTER TABLE series ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0;
-- Per episode: the choice offered at its end and what was picked (null for none).
ALTER TABLE series ADD COLUMN choices_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS stickers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  sticker TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stickers_owner ON stickers (owner_id, id);

CREATE TABLE IF NOT EXISTS radio_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  aired_at TEXT,
  answer TEXT
);
CREATE INDEX IF NOT EXISTS radio_questions_pending ON radio_questions (owner_id, aired_at, id);
