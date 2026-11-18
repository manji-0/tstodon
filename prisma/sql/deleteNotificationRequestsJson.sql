-- @param {String} $1:accountId
-- @param {String} $2:fromAccountIdsJson
DELETE FROM notification_requests
WHERE account_id = $1 AND from_account_id IN (SELECT value FROM json_each($2))
