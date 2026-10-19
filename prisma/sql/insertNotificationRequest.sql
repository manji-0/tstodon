-- @param {String} $1:notificationId
-- @param {String} $2:accountId
-- @param {String} $3:fromAccountId
-- @param {String} $4:now
INSERT INTO notification_requests (notification_id, account_id, from_account_id, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT(notification_id) DO NOTHING
