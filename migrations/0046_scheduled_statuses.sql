-- Scheduled statuses: the validated params are stored until the cron publisher
-- is due, then they go through the same publish path as an immediate post.

CREATE TABLE IF NOT EXISTS scheduled_statuses (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    params_json TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scheduled_statuses_account
    ON scheduled_statuses (account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_statuses_due
    ON scheduled_statuses (scheduled_at);
