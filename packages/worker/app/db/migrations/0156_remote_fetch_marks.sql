-- When the poll of a remote status was last read from its server, by an
-- `Update` or by a client reading the poll (Mastodon's `polls.last_fetched_at`).
-- NULL until the first: the `Create` that stored the poll does not count.
ALTER TABLE remote_statuses ADD COLUMN poll_fetched_at TEXT;

-- The `fetched_at` of the actor's document whose profile field links were
-- last looked at for a check (Mastodon's `VerifyAccountLinksWorker`, which
-- each processing of the actor queues). NULL until the first look.
ALTER TABLE remote_actors ADD COLUMN links_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_remote_actors_links_due
  ON remote_actors (fetched_at)
  WHERE links_checked_at IS NULL OR links_checked_at < fetched_at;
