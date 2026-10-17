-- @param {String} $1:accountId
-- @param {String} $2:notificationId
-- @param {String} $3:createdAt
INSERT INTO notification_dismissals (account_id, notification_id, created_at)
VALUES ($1, $2, $3)
ON CONFLICT(account_id, notification_id) DO NOTHING
