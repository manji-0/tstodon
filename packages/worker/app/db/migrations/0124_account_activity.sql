-- Minimal activity tracking for the admin measures and the account IPs.
-- `account_activity_days`: one row per local account per UTC day it made an
-- authenticated request (API token or browser session), for the
-- `active_users` measure and the retention cohorts (Mastodon counts these in
-- Redis). `account_ips`: the addresses an account signed up or made requests
-- from, with when each was last used, as Mastodon's `user_ips`. The Worker
-- writes each pair at most once per isolate per day.

CREATE TABLE IF NOT EXISTS account_activity_days (
    account_id TEXT NOT NULL,
    day TEXT NOT NULL,
    PRIMARY KEY (account_id, day),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_account_activity_days_day ON account_activity_days (day);

CREATE TABLE IF NOT EXISTS account_ips (
    account_id TEXT NOT NULL,
    ip TEXT NOT NULL,
    used_at TEXT NOT NULL,
    PRIMARY KEY (account_id, ip),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) WITHOUT ROWID;
