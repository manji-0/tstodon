-- @param {String} $1:notificationId
-- @param {String} $2:accountId
-- @param {String} $3:fromAccountId
-- @param {String} $4:statusId?
-- @param {String} $5:now
INSERT INTO notification_requests (notification_id, account_id, from_account_id, status_id, created_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT(notification_id) DO NOTHING
