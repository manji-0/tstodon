-- @param {String} $1:kind
-- @param {String} $2:reasonKind?
-- @param {Int} $3:attemptCount
-- @param {Int} $4:httpStatus?
-- @param {String} $5:updatedAt
-- @param {String} $6:activityId
-- @param {String} $7:inboxUrl
-- @param {String} $8:nextAttemptAt?
UPDATE outbox_deliveries
SET kind = $1, reason_kind = $2, attempt_count = $3, http_status = $4, updated_at = $5,
    next_attempt_at = $8
WHERE activity_id = $6 AND inbox_url = $7 AND kind = 'Queued'
