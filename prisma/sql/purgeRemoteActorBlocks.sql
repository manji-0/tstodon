-- @param {String} $1:actorUri
DELETE FROM blocks WHERE target_actor_uri = $1
