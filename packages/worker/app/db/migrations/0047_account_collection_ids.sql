-- Mastodon pages the block, mute, and endorsement collections by the row id.
-- These tables are keyed by their participants, so they get a time-ordered id
-- (the same numeric entity id shape the rest of the schema uses), backfilled
-- from `created_at` for rows written before this migration.

ALTER TABLE blocks ADD COLUMN id TEXT;
ALTER TABLE mutes ADD COLUMN id TEXT;
ALTER TABLE endorsements ADD COLUMN id TEXT;

UPDATE blocks SET id = CAST(strftime('%s', created_at) AS INTEGER) * 1000 * 65536 + abs(random() % 65536) WHERE id IS NULL;
UPDATE mutes SET id = CAST(strftime('%s', created_at) AS INTEGER) * 1000 * 65536 + abs(random() % 65536) WHERE id IS NULL;
UPDATE endorsements SET id = CAST(strftime('%s', created_at) AS INTEGER) * 1000 * 65536 + abs(random() % 65536) WHERE id IS NULL;

CREATE INDEX IF NOT EXISTS idx_blocks_id ON blocks (id);
CREATE INDEX IF NOT EXISTS idx_mutes_id ON mutes (id);
CREATE INDEX IF NOT EXISTS idx_endorsements_id ON endorsements (id);
