-- Per-account notification filtering policy (Mastodon 4.3) and the requests it
-- holds back: `filter` keeps a notification out of the list until the
-- recipient accepts the sender, `drop` never creates one.

CREATE TABLE IF NOT EXISTS notification_policies (
    account_id TEXT PRIMARY KEY,
    for_not_following TEXT NOT NULL DEFAULT 'accept',
    for_not_followers TEXT NOT NULL DEFAULT 'accept',
    for_new_accounts TEXT NOT NULL DEFAULT 'accept',
    for_private_mentions TEXT NOT NULL DEFAULT 'drop',
    for_limited_accounts TEXT NOT NULL DEFAULT 'filter',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_requests (
    notification_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    from_account_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_requests_account
    ON notification_requests (account_id, from_account_id);

CREATE TABLE IF NOT EXISTS notification_request_acceptances (
    account_id TEXT NOT NULL,
    from_account_id TEXT NOT NULL,
    accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, from_account_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
