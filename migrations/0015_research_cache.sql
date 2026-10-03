-- Research that several items of a day share (the headlines): kept briefly, so the same web search or
-- feed round is not paid for again by the next block.
CREATE TABLE IF NOT EXISTS research_cache (
  owner_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, cache_key)
);
