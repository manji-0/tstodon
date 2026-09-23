-- @param {String} $1:remoteActorUri
-- @param {String} $2:statusId
DELETE FROM remote_announces WHERE remote_actor_uri = $1 AND status_id = $2
