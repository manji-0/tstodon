-- Per-account domain blocks (GET/POST/DELETE /api/v1/domain_blocks).

CREATE TABLE IF NOT EXISTS account_domain_blocks (
    account_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, domain),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_domain_blocks_account_created
    ON account_domain_blocks (account_id, created_at DESC);
