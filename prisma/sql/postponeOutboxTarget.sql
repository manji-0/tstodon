-- @param {String} $1:nextAttemptAt
-- @param {String} $2:activityId
-- @param {String} $3:inboxUrl
UPDATE outbox_deliveries SET next_attempt_at = $1
WHERE activity_id = $2 AND inbox_url = $3 AND kind = 'Queued'
