-- The moment a local voter was told a local poll they voted on had ended.
-- Every row of one voter on one poll (one per chosen option) carries it.
ALTER TABLE poll_votes ADD COLUMN expiry_notified_at TEXT;

-- Polls that ended before this migration are not announced after the fact.
UPDATE poll_votes
SET expiry_notified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE poll_id IN (
  SELECT id FROM polls
  WHERE expiry_notified_at IS NOT NULL
    OR expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_expiry_pending
    ON poll_votes (poll_id)
    WHERE expiry_notified_at IS NULL;
