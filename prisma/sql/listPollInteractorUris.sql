-- The remote actors that voted on a local status's poll or boosted the status.
-- @param {String} $1:statusId
SELECT v.actor_uri
FROM remote_poll_votes v
JOIN polls p ON p.id = v.poll_id
WHERE p.status_id = $1
UNION
SELECT remote_actor_uri AS actor_uri FROM remote_announces WHERE status_id = $1
