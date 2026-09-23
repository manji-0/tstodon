-- @param {String} $1:id
-- @param {String} $2:activityId
-- @param {String} $3:kind
-- @param {Int} $4:attemptCount
-- @param {String} $5:createdAt
-- @param {String} $6:updatedAt
INSERT INTO outbox_deliveries (id, activity_id, kind, attempt_count, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6)
