-- Live transitions (GET /api/linker) are capped per owner and UTC day, separately from productions.
CREATE TABLE IF NOT EXISTS daily_linker_requests (
  owner_id TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  requests INTEGER NOT NULL CHECK (requests >= 0),
  PRIMARY KEY (owner_id, utc_day)
);
