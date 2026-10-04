-- Invitations: the owner hands out a single-use code; redeeming it creates an Access service token and
-- a station for the new listener. Only a hash of the code is kept.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('family', 'kids', 'guest')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  owner_id TEXT
);

-- Listeners who joined by invitation (those in the LISTENERS secret stay there).
CREATE TABLE IF NOT EXISTS invited_listeners (
  client_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('family', 'kids', 'guest')),
  token_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Wrong codes per address and hour, so the public join page cannot be used to guess codes.
CREATE TABLE IF NOT EXISTS join_attempts (
  ip_hash TEXT NOT NULL,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, hour)
);
