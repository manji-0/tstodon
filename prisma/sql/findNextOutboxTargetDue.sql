-- @param {String} $1:activityId
-- @param {String} $2:inboxUrl?
-- The earliest next attempt among an activity's `Queued` targets (only
-- `$2`'s when given); NULL first, for a target never attempted. No row when
-- none is `Queued`.
SELECT next_attempt_at
FROM outbox_deliveries
WHERE activity_id = $1 AND inbox_url IS NOT NULL AND kind = 'Queued'
  AND ($2 IS NULL OR inbox_url = $2)
ORDER BY next_attempt_at
LIMIT 1
