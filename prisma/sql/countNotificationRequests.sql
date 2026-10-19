-- @param {String} $1:accountId
SELECT COUNT(DISTINCT from_account_id) AS requests, COUNT(*) AS notifications
FROM notification_requests WHERE account_id = $1
