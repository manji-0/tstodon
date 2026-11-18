-- An ActivityPub outbox page merges one index range per visibility its
-- fetcher may read (public and unlisted, followers-only for a follower), in
-- id order: a page reads its own rows, not the account's statuses of the
-- other visibilities between them.
CREATE INDEX IF NOT EXISTS idx_statuses_account_visibility_id
    ON statuses (account_id, visibility, id);
