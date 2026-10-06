-- Provider calls and tokens per station and day, so the costs can be shown per listener. The owner's
-- totals stay in model_usage; calls made outside any station (none today) count under ''.
CREATE TABLE IF NOT EXISTS owner_usage (
  utc_day TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (utc_day, owner_id, provider, model)
);
