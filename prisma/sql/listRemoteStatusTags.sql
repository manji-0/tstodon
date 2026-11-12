-- @param {String} $1:idsJson
SELECT status_id, tag FROM remote_status_tags
WHERE status_id IN (SELECT value FROM json_each($1))
ORDER BY rowid
