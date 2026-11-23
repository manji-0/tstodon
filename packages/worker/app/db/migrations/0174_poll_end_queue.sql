-- void:allow-destructive
-- (Void gate: only the index `idx_poll_votes_expiry_pending` on (poll_id) is
-- dropped, replaced by `idx_poll_votes_unnotified` on (poll_id, account_id)
-- under the same condition.)
--
-- The end of a poll is queued once per poll (`AwaitPollEnd`, as Mastodon's
-- `PollExpirationNotifyWorker` holds one job per poll): the instant queued is
-- kept on the poll, a later schedule for the same instant queues nothing, and
-- a queued job whose instant is no longer the poll's stops.
ALTER TABLE polls ADD COLUMN end_queued_at TEXT;
ALTER TABLE remote_statuses ADD COLUMN poll_end_queued_at TEXT;

-- Each run of `ProcessExpiredPolls` reads the votes whose voter has not been
-- told the poll ended, in (poll, voter) order; without these it scans every
-- vote ever cast.
CREATE INDEX IF NOT EXISTS idx_remote_poll_own_votes_unnotified
    ON remote_poll_own_votes (status_id, account_id) WHERE expiry_notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_poll_votes_unnotified
    ON poll_votes (poll_id, account_id) WHERE expiry_notified_at IS NULL;
DROP INDEX IF EXISTS idx_poll_votes_expiry_pending;
