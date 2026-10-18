-- @param {String} $1:accountId
DELETE FROM account_flags WHERE account_id = $1
RETURNING account_id
