-- @param {String} $1:idsJson
SELECT status_id, account_id FROM remote_status_mentions
WHERE status_id IN (SELECT value FROM json_each($1))
