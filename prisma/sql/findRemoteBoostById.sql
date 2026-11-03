-- @param {String} $1:id
SELECT id, actor_uri, activity_id, local_status_id, remote_status_id, visibility, published_at
FROM remote_boosts WHERE id = $1
