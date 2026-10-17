-- Follow requests: remember the original Follow activity id on a pending remote
-- follow so authorize can send a well-formed Accept / Reject that references it.

ALTER TABLE remote_follows ADD COLUMN follow_activity_id TEXT;

CREATE INDEX IF NOT EXISTS idx_remote_follows_pending
    ON remote_follows (target_account_id, remote_request_kind);
