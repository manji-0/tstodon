-- When the poll of a remote status was last read from its server, by an
-- `Update` or by a client reading the poll (Mastodon's `polls.last_fetched_at`).
-- NULL until the first: the `Create` that stored the poll does not count.
ALTER TABLE remote_statuses ADD COLUMN poll_fetched_at TEXT;
