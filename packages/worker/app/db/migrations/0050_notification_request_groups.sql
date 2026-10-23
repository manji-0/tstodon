-- Notification requests get a stable id of their own, so the list can page by
-- it. One group per (account, sender); the held notifications still live in
-- `notification_requests` and are counted through the group.

CREATE TABLE IF NOT EXISTS notification_request_groups (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    from_account_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (account_id, from_account_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Backfill the groups of notifications already held back.
INSERT OR IGNORE INTO notification_request_groups (id, account_id, from_account_id, created_at)
SELECT
    CAST(strftime('%s', MIN(created_at)) AS INTEGER) * 1000 * 65536
        + (SELECT COUNT(*) FROM notification_requests) * 1000
        + abs(random() % 1000),
    account_id,
    from_account_id,
    MIN(created_at)
FROM notification_requests
GROUP BY account_id, from_account_id;
