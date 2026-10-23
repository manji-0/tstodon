-- Admin "sensitize" flag: a row exists only while the account is sensitized,
-- so statuses can force `sensitive` from one lookup.

CREATE TABLE IF NOT EXISTS account_flags (
    account_id TEXT PRIMARY KEY,
    sensitized INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
