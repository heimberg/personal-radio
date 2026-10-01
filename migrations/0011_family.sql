-- Family: the owner and the listeners share items, chat, greet each other on air and see who hears what.
-- Senders and recipients are owner IDs; the API shows member names only.
CREATE TABLE IF NOT EXISTS family_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  recipient TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'share', 'greeting')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS family_reads (
  owner_id TEXT PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0
);

-- What each member hears right now, as long as the item lasts.
CREATE TABLE IF NOT EXISTS family_presence (
  owner_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  until TEXT NOT NULL
);

-- Greetings the host reads in the recipient's next live transition.
CREATE TABLE IF NOT EXISTS family_greetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  aired_at TEXT
);
CREATE INDEX IF NOT EXISTS family_greetings_pending ON family_greetings (recipient, aired_at, id);
