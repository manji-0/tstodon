-- @param {String} $1:id
-- @param {String} $2:activityId
-- @param {String} $3:kind
-- @param {Int} $4:attemptCount
-- @param {String} $5:inboxUrl
-- @param {String} $6:createdAt
-- @param {String} $7:updatedAt
INSERT OR IGNORE INTO outbox_deliveries
 (id, activity_id, kind, attempt_count, inbox_url, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
