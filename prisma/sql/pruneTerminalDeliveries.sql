-- @param {String} $1:updatedBefore
-- @param {Int} $2:limit
-- Up to `limit` of the oldest delivery rows in a final state, last changed
-- before `updatedBefore`: a target `Delivered` or `Failed`, a fan-out row
-- `Expanded` or `Delivered`. `Queued` rows, and any state not listed here,
-- stay. The list matches `idx_outbox_deliveries_finished`, so the scan only
-- visits rows it may delete.
DELETE FROM outbox_deliveries
WHERE id IN (
    SELECT id FROM outbox_deliveries
    WHERE kind IN ('Delivered', 'Failed', 'Expanded', 'Skipped')
      AND updated_at < $1
    ORDER BY updated_at
    LIMIT $2
  )
