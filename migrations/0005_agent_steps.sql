-- Durable checkpoints of the editorial team: one row per finished agent task of a production run.
CREATE TABLE IF NOT EXISTS agent_steps (
  run_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step_name)
);
