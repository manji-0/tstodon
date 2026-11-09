-- Remote domains deliveries have been failing to: Mastodon's
-- `DeliveryFailureTracker` (distinct days with a failed delivery) and
-- `UnavailableDomain`, one row per domain (`DeliveryDomainHealth` in
-- packages/domain). `kind` is `Failing`, or `Unavailable` once failures were
-- recorded on 7 distinct UTC days with no success between; deliveries to an
-- unavailable domain are skipped. A successful delivery to the domain, a
-- verified inbound activity from it, or an admin's "Mark as available"
-- deletes the row.
CREATE TABLE IF NOT EXISTS delivery_domain_health (
    domain TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    failure_days INTEGER NOT NULL,
    last_failure_day TEXT NOT NULL,
    unavailable_since TEXT,
    updated_at TEXT NOT NULL
);

-- When a `Queued` target's next attempt is due: set by the delivery Workflow
-- before it sleeps, and by the stuck-delivery sweep. NULL until the first
-- attempt; the sweep reads `updated_at` (the row's creation) then.
ALTER TABLE outbox_deliveries ADD COLUMN next_attempt_at TEXT;

-- The hourly stuck-delivery sweep: `Queued` targets whose attempt is overdue.
CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_due
    ON outbox_deliveries (COALESCE(next_attempt_at, updated_at))
    WHERE kind = 'Queued' AND inbox_url IS NOT NULL;
