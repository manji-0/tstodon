-- Pinned statuses: an account's featured posts.

CREATE TABLE IF NOT EXISTS status_pins (
    account_id TEXT NOT NULL,
    status_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, status_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_status_pins_account_created
    ON status_pins (account_id, created_at DESC);
