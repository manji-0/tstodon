-- @param {String} $1:activityId
-- Drop the key kept for a deleted account's last activity once none of the
-- activity's targets is still to be attempted.
DELETE FROM outbound_departed_signers
WHERE activity_id = $1
  AND NOT EXISTS (
    SELECT 1 FROM outbox_deliveries
    WHERE activity_id = $1 AND inbox_url IS NOT NULL AND kind = 'Queued'
  )
