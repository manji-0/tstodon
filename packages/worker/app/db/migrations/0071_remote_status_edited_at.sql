-- When a remote author last edited a cached note (the `updated` of the
-- `Update` that carried the edit). NULL for notes never edited since cached.
ALTER TABLE remote_statuses ADD COLUMN edited_at TEXT;
