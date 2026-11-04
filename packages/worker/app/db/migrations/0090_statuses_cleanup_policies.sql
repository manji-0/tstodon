-- Automated post deletion: one policy per account, as Mastodon's
-- `account_statuses_cleanup_policies`. A missing row is the default policy
-- (disabled). `min_status_age` is in seconds. `min_favs` and `min_reblogs`
-- are NULL when that keep rule is off. `last_inspected_id` is the last
-- status the cleanup job looked at, so a run resumes after the posts it kept;
-- empty when the next run starts from the oldest post.

CREATE TABLE statuses_cleanup_policies (
    account_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    min_status_age INTEGER NOT NULL DEFAULT 1209600,
    keep_pinned INTEGER NOT NULL DEFAULT 1,
    keep_direct INTEGER NOT NULL DEFAULT 1,
    keep_self_fav INTEGER NOT NULL DEFAULT 1,
    keep_self_bookmark INTEGER NOT NULL DEFAULT 1,
    keep_polls INTEGER NOT NULL DEFAULT 0,
    keep_media INTEGER NOT NULL DEFAULT 0,
    min_favs INTEGER,
    min_reblogs INTEGER,
    last_inspected_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_statuses_cleanup_policies_enabled
    ON statuses_cleanup_policies (account_id) WHERE enabled = 1;
