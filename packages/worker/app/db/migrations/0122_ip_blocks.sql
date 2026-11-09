-- Mastodon's IP blocks (`/api/v1/admin/ip_blocks`). `ip` is the range in its
-- canonical CIDR form (network address and prefix, `192.0.2.0/24`), so one
-- range is stored once. `severity` is Mastodon's name for what the range may
-- not do: `sign_up_requires_approval`, `sign_up_block` or `no_access`. A
-- block with `expires_at` in the past is no longer enforced.

CREATE TABLE IF NOT EXISTS ip_blocks (
    id TEXT NOT NULL PRIMARY KEY,
    ip TEXT NOT NULL UNIQUE,
    severity TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT
);
