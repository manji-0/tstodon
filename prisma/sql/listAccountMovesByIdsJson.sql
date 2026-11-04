-- @param {String} $1:idsJson
SELECT account_id, target_uri FROM account_moves WHERE account_id IN (SELECT value FROM json_each($1))
