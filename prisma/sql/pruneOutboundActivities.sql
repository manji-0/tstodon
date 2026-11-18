-- @param {String} $1:createdBefore
-- @param {Int} $2:limit
-- Up to `limit` of the oldest outbound activities created before
-- `createdBefore` that nothing reads any more. An activity stays while a
-- delivery row of it is unfinished (any state but `Delivered`, `Failed`,
-- `Expanded`, `Skipped`): the delivery Workflow and `ExpandFollowers` read its
-- JSON; a missing activity would fail the delivery as a 404.
-- Nothing else reads a stored activity: the ActivityPub outbox renders the
-- statuses as they are now, and `Undo` and `Delete` are built from
-- `outbound_follows`, the statuses and the interaction tables, not from here.
DELETE FROM outbound_activities
WHERE id IN (
    SELECT o.id FROM outbound_activities o
    WHERE o.created_at < $1
      AND NOT EXISTS (
        SELECT 1 FROM outbox_deliveries d
        WHERE d.activity_id = o.id AND d.inbox_url IS NULL
          AND d.kind NOT IN ('Delivered', 'Failed', 'Expanded', 'Skipped')
      )
      AND NOT EXISTS (
        SELECT 1 FROM outbox_deliveries d
        WHERE d.activity_id = o.id AND d.inbox_url IS NOT NULL
          AND d.kind NOT IN ('Delivered', 'Failed', 'Expanded', 'Skipped')
      )
    ORDER BY o.created_at
    LIMIT $2
  )
