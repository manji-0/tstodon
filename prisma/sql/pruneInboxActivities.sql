-- @param {String} $1:receivedBefore
-- @param {Int} $2:limit
-- Up to `limit` of the oldest handled activities, from before
-- `receivedBefore`. The row is only the inbox's dedupe by activity id (no
-- read uses its payload), so the retention keeps it past remote retries. A
-- `Processing` claim is left to `releaseStaleInboxClaims`.
DELETE FROM inbox_activities
WHERE activity_id IN (
    SELECT activity_id FROM inbox_activities
    WHERE state = 'Processed'
      AND created_at < $1
    ORDER BY created_at
    LIMIT $2
  )
