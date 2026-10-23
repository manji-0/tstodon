-- Local-account moderation: a row exists only while an account is silenced or
-- suspended, so public surfaces can exclude it with one NOT IN clause.

CREATE TABLE IF NOT EXISTS account_moderation (
    account_id TEXT PRIMARY KEY,
    moderation TEXT NOT NULL CHECK (moderation IN ('Silenced', 'Suspended')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_moderation_state
    ON account_moderation (moderation, account_id);
