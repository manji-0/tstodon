ALTER TABLE accounts ADD COLUMN bio_text TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN avatar_object_key TEXT;
ALTER TABLE accounts ADD COLUMN header_object_key TEXT;

ALTER TABLE statuses ADD COLUMN spoiler_text TEXT NOT NULL DEFAULT '';
ALTER TABLE statuses ADD COLUMN language TEXT;
ALTER TABLE statuses ADD COLUMN content_html TEXT NOT NULL DEFAULT '';
ALTER TABLE statuses ADD COLUMN poll_id TEXT;

CREATE TABLE IF NOT EXISTS favourites (
    account_id TEXT NOT NULL,
    status_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, status_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bookmarks (
    account_id TEXT NOT NULL,
    status_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, status_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    from_account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (from_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_account_created_at
    ON notifications (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    status_id TEXT NOT NULL UNIQUE,
    multiple INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    options_json TEXT NOT NULL,
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    option_index INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (poll_id, account_id, option_index),
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    target_account_id TEXT NOT NULL,
    status_ids_json TEXT NOT NULL DEFAULT '[]',
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS filters (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    phrase TEXT NOT NULL,
    context_json TEXT NOT NULL,
    whole_word INTEGER NOT NULL DEFAULT 0,
    irreversible INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outbound_activities (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follows_target
    ON follows (target_account_id, kind);

CREATE INDEX IF NOT EXISTS idx_statuses_visibility_created_at
    ON statuses (visibility, created_at DESC);
