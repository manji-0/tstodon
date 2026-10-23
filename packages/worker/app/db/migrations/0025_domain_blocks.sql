-- Server-wide domain blocks (admin API). `silence` hides a domain from public
-- surfaces, `suspend` also refuses federation with it, `noop` is audit only.

CREATE TABLE IF NOT EXISTS domain_blocks (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    severity TEXT NOT NULL CHECK (severity IN ('silence', 'suspend', 'noop')),
    reject_media INTEGER NOT NULL DEFAULT 0,
    reject_reports INTEGER NOT NULL DEFAULT 0,
    obfuscate INTEGER NOT NULL DEFAULT 0,
    private_comment TEXT,
    public_comment TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_domain_blocks_severity
    ON domain_blocks (severity, domain);
