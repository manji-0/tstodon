-- Custom emoji a remote note declares in its `tag` (JSON array of
-- { shortcode, url }), and the moment a local voter was told a remote poll
-- they voted on had ended.
ALTER TABLE remote_statuses ADD COLUMN emojis_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE remote_poll_own_votes ADD COLUMN expiry_notified_at TEXT;

-- Polls that ended before this migration are not announced after the fact.
UPDATE remote_poll_own_votes
SET expiry_notified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status_id IN (
  SELECT id FROM remote_statuses
  WHERE json_extract(poll_json, '$.ends.at') IS NOT NULL
    AND json_extract(poll_json, '$.ends.at') <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- Edit history of remote notes: the version an inbound `Update` replaced, one
-- snapshot JSON per edit.
CREATE TABLE remote_status_edits (
    id TEXT PRIMARY KEY,
    status_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_status_edits_status_created
    ON remote_status_edits (status_id, created_at DESC, id DESC);
