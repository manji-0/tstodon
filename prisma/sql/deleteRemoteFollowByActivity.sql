-- @param {String} $1:remoteActorUri
-- @param {String} $2:followActivityId
DELETE FROM remote_follows WHERE remote_actor_uri = $1 AND follow_activity_id = $2
