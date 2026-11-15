-- The usernames of deleted local accounts. `GET /users/:username` answers
-- 410 Gone for one, as Mastodon does for a deleted account's actor, where an
-- unknown name answers 404: a remote server that asks after the `Delete` is
-- told the account is gone for good. A name registered again is found in
-- `accounts` first, so its row here is never read.
CREATE TABLE deleted_account_names (
    username TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL
);
