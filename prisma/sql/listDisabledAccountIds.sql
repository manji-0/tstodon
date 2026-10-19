-- @param {String} $1:idsJson
SELECT account_id FROM account_flags
WHERE disabled <> 0 AND account_id IN (SELECT value FROM json_each($1))
