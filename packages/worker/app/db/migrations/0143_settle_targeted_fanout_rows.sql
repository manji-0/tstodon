-- Every outbound activity has a fan-out row in `outbox_deliveries` (the one
-- with no `inbox_url`), `Queued` until `ExpandFollowers` has listed the
-- followers' inboxes. An activity sent to named inboxes (an `Accept`, a
-- `Follow`, a forwarded report) never runs that job, and its fan-out row was
-- left `Queued`. The activity vacuum keeps an activity whose fan-out row is
-- unfinished, so those activities were never pruned.
-- New ones store the row as `Expanded`. This settles the old ones: a `Queued`
-- fan-out row whose activity already has targets belongs to such an activity,
-- because `ExpandFollowers` settles the row before it stores a target.
-- `updated_at` stays, so the vacuum prunes what is already past its window.
UPDATE outbox_deliveries
SET kind = 'Expanded'
WHERE inbox_url IS NULL
  AND kind = 'Queued'
  AND EXISTS (
    SELECT 1 FROM outbox_deliveries t
    WHERE t.activity_id = outbox_deliveries.activity_id AND t.inbox_url IS NOT NULL
  );
