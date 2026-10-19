-- `Idempotency-Key` responses for POST /api/v1/statuses: a key maps to the
-- status it created and expires after an hour.

CREATE TABLE IF NOT EXISTS status_idempotency (
    account_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, idempotency_key),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_status_idempotency_created
    ON status_idempotency (account_id, created_at);
