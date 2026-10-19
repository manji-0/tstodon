-- Sign-up blocks: a canonical email hash (dots and +tags stripped, so the same
-- mailbox cannot re-register after a moderation action) and blocked email
-- domains.

CREATE TABLE IF NOT EXISTS canonical_email_blocks (
    id TEXT PRIMARY KEY,
    canonical_email_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_domain_blocks (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
