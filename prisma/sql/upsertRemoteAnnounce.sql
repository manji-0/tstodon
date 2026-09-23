-- @param {String} $1:remoteActorUri
-- @param {String} $2:statusId
-- @param {String} $3:activityId
-- @param {String} $4:createdAt
INSERT INTO remote_announces (remote_actor_uri, status_id, activity_id, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT(remote_actor_uri, status_id) DO UPDATE SET
  activity_id = excluded.activity_id
