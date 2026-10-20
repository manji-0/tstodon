-- Engagement rows get a time-ordered id so a status's favourited_by and
-- reblogged_by collections can page by it (local reblogs already page by the
-- reblog status id).

ALTER TABLE favourites ADD COLUMN id TEXT;
ALTER TABLE remote_favourites ADD COLUMN id TEXT;
ALTER TABLE remote_announces ADD COLUMN id TEXT;

UPDATE favourites SET id = CAST(strftime('%s', created_at) AS INTEGER) * 1000 * 65536 + abs(random() % 65536) WHERE id IS NULL;
UPDATE remote_favourites SET id = CAST(strftime('%s', created_at) AS INTEGER) * 1000 * 65536 + abs(random() % 65536) WHERE id IS NULL;
UPDATE remote_announces SET id = CAST(strftime('%s', created_at) AS INTEGER) * 1000 * 65536 + abs(random() % 65536) WHERE id IS NULL;

CREATE INDEX IF NOT EXISTS idx_favourites_id ON favourites (id);
CREATE INDEX IF NOT EXISTS idx_remote_favourites_id ON remote_favourites (id);
CREATE INDEX IF NOT EXISTS idx_remote_announces_id ON remote_announces (id);
