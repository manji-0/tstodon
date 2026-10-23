ALTER TABLE polls ADD COLUMN expiry_notified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_polls_expires_at
    ON polls (expires_at)
    WHERE expiry_notified_at IS NULL;
