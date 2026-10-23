CREATE TABLE IF NOT EXISTS instance_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    domain TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    access_email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,
    default_post_visibility TEXT NOT NULL DEFAULT 'public',
    default_quote_policy TEXT NOT NULL DEFAULT 'public',
    public_key_pem TEXT NOT NULL,
    private_key_jwk TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS statuses (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ap_id TEXT UNIQUE,
    reblog_of_id TEXT,
    in_reply_to_id TEXT,
    content_text TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (reblog_of_id) REFERENCES statuses(id) ON DELETE SET NULL,
    FOREIGN KEY (in_reply_to_id) REFERENCES statuses(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_statuses_account_created_at
    ON statuses (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS media_attachments (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    status_id TEXT,
    object_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS follows (
    id TEXT PRIMARY KEY,
    follower_account_id TEXT NOT NULL,
    target_account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (follower_account_id, target_account_id),
    FOREIGN KEY (follower_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outbox_deliveries (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason_kind TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    http_status INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inbox_activities (
    activity_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
