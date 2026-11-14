-- @param {String} $1:idsJson
-- The remote actors each remote note mentions, in the order they were stored.
SELECT status_id, actor_uri FROM remote_status_remote_mentions
WHERE status_id IN (SELECT value FROM json_each($1))
ORDER BY rowid
