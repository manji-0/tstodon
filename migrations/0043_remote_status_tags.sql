-- Remote statuses carry no tag index, so the tag timeline used to scan recent
-- rows. Persisting now records the tags found in the stored HTML, and the cron
-- job indexes the rows written before this migration.

CREATE TABLE IF NOT EXISTS remote_status_tags (
    status_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (status_id, tag),
    FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_remote_status_tags_tag
    ON remote_status_tags (tag, status_id);

ALTER TABLE remote_statuses ADD COLUMN tags_indexed INTEGER NOT NULL DEFAULT 0;
