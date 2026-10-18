-- @param {String} $1:accountId
SELECT moderation FROM account_moderation WHERE account_id = $1 LIMIT 1
