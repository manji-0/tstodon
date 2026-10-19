-- Public profile extras: bio text, profile fields, and the bot/discoverable
-- flags. Kept beside `accounts` so no account row query has to change.

CREATE TABLE IF NOT EXISTS account_profiles (
    account_id TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT '',
    fields_json TEXT NOT NULL DEFAULT '[]',
    bot INTEGER NOT NULL DEFAULT 0,
    discoverable INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
