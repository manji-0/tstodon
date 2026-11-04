-- @param {String} $1:idsJson
SELECT account_id, target_uri FROM account_moves
WHERE cancelled_at IS NULL AND account_id IN (SELECT value FROM json_each($1))
