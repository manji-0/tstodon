-- When the reply tree walk last read a cached remote status's `replies`, as
-- Mastodon's `statuses.fetched_replies_at`: a walk skips a status read within
-- the cooldown (`FETCH_REPLIES_COOLDOWN_MINUTES`).
ALTER TABLE remote_statuses ADD COLUMN replies_fetched_at TEXT;
