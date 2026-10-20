-- @param {String} $1:id
-- @param {String} $2:remoteActorUri
-- @param {String} $3:statusId
-- @param {String} $4:activityId
-- @param {String} $5:createdAt
INSERT INTO remote_announces (id, remote_actor_uri, status_id, activity_id, created_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT(remote_actor_uri, status_id) DO UPDATE SET
  activity_id = excluded.activity_id
