-- @param {String} $1:statusId
-- @param {Int} $2:limit
SELECT remote_actor_uri AS actor_uri, created_at FROM remote_announces
WHERE status_id = $1
ORDER BY created_at DESC, remote_actor_uri DESC
LIMIT $2
