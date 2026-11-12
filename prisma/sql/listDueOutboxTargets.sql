-- @param {String} $1:activityId
-- @param {String} $2:inboxUrl?
-- @param {String} $3:afterInboxUrl
-- @param {String} $4:dueBy
-- @param {Int} $5:limit
-- An activity's `Queued` targets (only `$2`'s when given) after `$3` in
-- inbox order whose next attempt is due by `$4`; a target never attempted
-- (no next attempt yet) is always due.
SELECT inbox_url, attempt_count
FROM outbox_deliveries
WHERE activity_id = $1 AND inbox_url > $3 AND kind = 'Queued'
  AND ($2 IS NULL OR inbox_url = $2)
  AND (next_attempt_at IS NULL OR next_attempt_at <= $4)
ORDER BY inbox_url
LIMIT $5
