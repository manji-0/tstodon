-- @param {String} $1:accountId
-- @param {String} $2:fromAccountId
SELECT from_account_id, COUNT(*) AS notifications_count, MAX(status_id) AS status_id,
       MIN(created_at) AS created_at, MAX(created_at) AS updated_at
FROM notification_requests
WHERE account_id = $1 AND from_account_id = $2
GROUP BY from_account_id
