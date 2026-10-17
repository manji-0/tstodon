-- @param {String} $1:accountId
-- @param {String} $2:notificationId
SELECT 1 AS present FROM notifications WHERE id = $2 AND account_id = $1 LIMIT 1
