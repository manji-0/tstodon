-- Blocks and mutes: keyed by the target actor URI, with the local target
-- account id recorded when the target is a local account.

CREATE TABLE IF NOT EXISTS blocks (
    blocker_account_id TEXT NOT NULL,
    target_account_id TEXT,
    target_actor_uri TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_account_id, target_actor_uri),
    FOREIGN KEY (blocker_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blocks_target_account_id
    ON blocks (target_account_id);

CREATE TABLE IF NOT EXISTS mutes (
    account_id TEXT NOT NULL,
    target_account_id TEXT,
    target_actor_uri TEXT NOT NULL,
    notifications INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, target_actor_uri),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mutes_target_account_id
    ON mutes (target_account_id);

CREATE INDEX IF NOT EXISTS idx_mutes_account_created_at
    ON mutes (account_id, created_at DESC);
