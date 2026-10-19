-- @param {String} $1:accountId
SELECT from_account_id, COUNT(*) AS notifications_count, MIN(created_at) AS created_at, MAX(created_at) AS updated_at
FROM notification_requests
WHERE account_id = $1
GROUP BY from_account_id
ORDER BY MAX(created_at) DESC
