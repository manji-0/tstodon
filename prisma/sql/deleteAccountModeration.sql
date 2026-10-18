-- @param {String} $1:accountId
DELETE FROM account_moderation WHERE account_id = $1
RETURNING account_id
