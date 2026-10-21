-- @param {String} $1:idsJson
SELECT status_id, actor_uri FROM status_remote_mentions
WHERE status_id IN (SELECT value FROM json_each($1))
