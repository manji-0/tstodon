-- @param {String} $1:accountId
-- @param {String} $2:fromAccountId
DELETE FROM notification_requests
WHERE account_id = $1 AND from_account_id = $2
RETURNING notification_id
