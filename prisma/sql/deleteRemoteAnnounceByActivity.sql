-- @param {String} $1:remoteActorUri
-- @param {String} $2:activityId
DELETE FROM remote_announces WHERE remote_actor_uri = $1 AND activity_id = $2
RETURNING status_id
