CREATE TABLE IF NOT EXISTS status_mentions (
    status_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    PRIMARY KEY (status_id, account_id),
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_status_mentions_account
    ON status_mentions (account_id, status_id);

CREATE TABLE IF NOT EXISTS markers (
    account_id TEXT NOT NULL,
    timeline TEXT NOT NULL CHECK (timeline IN ('home', 'notifications')),
    last_read_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, timeline),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_reads (
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    last_read_status_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
