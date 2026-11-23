-- The `Reject(Follow)` and `Undo(Follow)` a domain suspension owes the
-- suspended server, one row per accepted follow it removed, as Mastodon's
-- `DeleteAccountService` sends them (`reject_follows!`, `undo_follows!`).
-- The rows are written in the batch that removes the follows and deleted once
-- their activity is queued, by the `SendSeveranceNotices` pages, which claim
-- them first (`claimed_at`); a claim older than its page's time is taken again.
-- `id` is the notice's kind and the follow row's id, so a row is written once.
CREATE TABLE severance_notices (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('Reject', 'Undo')),
    account_id TEXT NOT NULL,
    actor_uri TEXT NOT NULL,
    follow_activity_id TEXT,
    claimed_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_severance_notices_claimed_at ON severance_notices (claimed_at);
