-- Notification actions: per-account dismissals and a clear marker.

CREATE TABLE IF NOT EXISTS notification_dismissals (
    account_id TEXT NOT NULL,
    notification_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, notification_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_clear_markers (
    account_id TEXT PRIMARY KEY,
    cleared_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
