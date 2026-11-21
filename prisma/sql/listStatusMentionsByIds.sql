-- @param {String} $1:idsJson
-- Only the mentions a note shows: a silent one only lets the account read it.
SELECT status_id, account_id FROM status_mentions
WHERE status_id IN (SELECT value FROM json_each($1)) AND silent = 0
