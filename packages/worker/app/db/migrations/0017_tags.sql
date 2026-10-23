-- Tag actions: followed tags and featured tags.

CREATE TABLE IF NOT EXISTS followed_tags (
    account_id TEXT NOT NULL,
    tag_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, tag_name),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_followed_tags_account_created
    ON followed_tags (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS featured_tags (
    account_id TEXT NOT NULL,
    tag_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, tag_name),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_featured_tags_account_created
    ON featured_tags (account_id, created_at DESC);
