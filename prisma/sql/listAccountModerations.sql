-- @param {String} $1:idsJson
SELECT account_id, moderation FROM account_moderation
WHERE account_id IN (SELECT value FROM json_each($1))
