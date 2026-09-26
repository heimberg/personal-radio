CREATE TABLE IF NOT EXISTS daily_usage (
  owner_id TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  characters INTEGER NOT NULL CHECK (characters >= 0),
  PRIMARY KEY (owner_id, utc_day)
);

CREATE TABLE IF NOT EXISTS daily_requests (
  owner_id TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  requests INTEGER NOT NULL CHECK (requests >= 0),
  PRIMARY KEY (owner_id, utc_day)
);
