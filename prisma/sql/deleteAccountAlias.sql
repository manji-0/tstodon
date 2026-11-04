-- @param {String} $1:accountId
-- @param {String} $2:id
DELETE FROM account_aliases WHERE account_id = $1 AND id = $2
