-- Followers collection synchronization (FEP-8fcf), as Mastodon v4.7.5.

-- Whether each POST of the activity carries a `Collection-Synchronization`
-- header (Mastodon's `synchronize_followers` delivery option): set for a
-- followers-only status's `Create`, `Update` or `Announce` from an account
-- with fewer than 25,000 followers.
ALTER TABLE outbound_activities ADD COLUMN synchronize_followers INTEGER NOT NULL DEFAULT 0;

-- The header's digest covers an account's followers on the inbox's host:
-- a range of follower URIs under one account.
CREATE INDEX IF NOT EXISTS idx_remote_follows_target_actor
  ON remote_follows (target_account_id, remote_actor_uri);

-- A `SynchronizeFollowers` job queued and not yet run, so the same one is not
-- queued twice meanwhile (`FollowersSynchronizationWorker`'s
-- `lock: :until_executed`). `digest` is '' when the header named none.
CREATE TABLE IF NOT EXISTS followers_synchronization_locks (
  actor_uri TEXT NOT NULL,
  url TEXT NOT NULL,
  digest TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  PRIMARY KEY (actor_uri, url, digest)
);
