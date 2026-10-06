-- Every call to an AI provider, for the owner's developer view: what went out, what came back (both
-- shortened), how long it took and what it cost in tokens. Kept two days and at most the newest 1000.
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  owner_id TEXT,
  item_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  request TEXT NOT NULL,
  response TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_calls_at ON llm_calls (at);
