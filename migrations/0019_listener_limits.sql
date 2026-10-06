-- A daily production limit per invited listener (NULL: the Worker's DAILY_GENERATIONS).
ALTER TABLE invited_listeners ADD COLUMN daily_generations INTEGER;
