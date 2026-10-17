-- Featured accounts (endorsements) and list exclusivity.

CREATE TABLE IF NOT EXISTS endorsements (
    account_id TEXT NOT NULL,
    target_account_id TEXT,
    target_actor_uri TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, target_actor_uri),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_endorsements_owner_created
    ON endorsements (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_endorsements_target_account_id
    ON endorsements (target_account_id);

ALTER TABLE account_lists ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0;
