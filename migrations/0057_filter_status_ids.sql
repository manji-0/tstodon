-- Mastodon's FilterStatus entity has its own id, distinct from the status id,
-- so `/api/v2/filters/statuses/:id` can address one entry. Existing rows get a
-- numeric id shaped like `newEntityId()` (milliseconds << 16, plus the rowid).

ALTER TABLE filter_statuses ADD COLUMN id TEXT;

UPDATE filter_statuses
  SET id = CAST(((CAST(strftime('%s', created_at) AS INTEGER) * 1000) << 16) + rowid AS TEXT)
  WHERE id IS NULL;

CREATE UNIQUE INDEX idx_filter_statuses_id ON filter_statuses (id);
