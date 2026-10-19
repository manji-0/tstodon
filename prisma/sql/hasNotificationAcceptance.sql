-- @param {String} $1:accountId
-- @param {String} $2:fromAccountId
SELECT from_account_id FROM notification_request_acceptances
WHERE account_id = $1 AND from_account_id = $2
