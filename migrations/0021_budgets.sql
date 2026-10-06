-- Monthly budgets in francs: one for the whole Worker (owner_id '*') and one per station. Once a
-- budget is used up, the station (or every station) produces only a few items a day until the month ends.
CREATE TABLE IF NOT EXISTS budgets (
  owner_id TEXT PRIMARY KEY,
  monthly_chf REAL NOT NULL,
  updated_at TEXT NOT NULL
);
