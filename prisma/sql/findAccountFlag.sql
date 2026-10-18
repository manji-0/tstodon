-- @param {String} $1:accountId
SELECT sensitized FROM account_flags WHERE account_id = $1 LIMIT 1
