-- @param {String} $1:idsJson
-- Only the mentions a note shows: a silent one only lets the actor read it.
SELECT status_id, actor_uri FROM status_remote_mentions
WHERE status_id IN (SELECT value FROM json_each($1)) AND silent = 0
