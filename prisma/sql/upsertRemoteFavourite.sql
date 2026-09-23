-- @param {String} $1:remoteActorUri
-- @param {String} $2:statusId
-- @param {String} $3:createdAt
INSERT INTO remote_favourites (remote_actor_uri, status_id, created_at)
VALUES ($1, $2, $3)
ON CONFLICT(remote_actor_uri, status_id) DO NOTHING
