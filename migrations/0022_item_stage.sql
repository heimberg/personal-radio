-- The production step an item is in (research, writing, editing, checking, voicing, music), so the
-- app can show how far the first item of a new program is.
ALTER TABLE timeline_items ADD COLUMN stage TEXT;
