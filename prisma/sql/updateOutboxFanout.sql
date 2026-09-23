-- @param {String} $1:kind
-- @param {String} $2:reasonKind?
-- @param {Int} $3:attemptCount
-- @param {Int} $4:httpStatus?
-- @param {String} $5:updatedAt
-- @param {String} $6:activityId
UPDATE outbox_deliveries
SET kind = $1, reason_kind = $2, attempt_count = $3, http_status = $4, updated_at = $5
WHERE activity_id = $6 AND inbox_url IS NULL
