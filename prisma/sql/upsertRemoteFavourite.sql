-- @param {String} $1:id
-- @param {String} $2:remoteActorUri
-- @param {String} $3:statusId
-- @param {String} $4:createdAt
INSERT INTO remote_favourites (id, remote_actor_uri, status_id, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT(remote_actor_uri, status_id) DO NOTHING
