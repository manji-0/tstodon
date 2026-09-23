-- @param {String} $1:activityId
-- @param {String} $2:inboxUrl
SELECT kind, reason_kind, attempt_count, http_status, inbox_url
FROM outbox_deliveries WHERE activity_id = $1 AND inbox_url = $2
