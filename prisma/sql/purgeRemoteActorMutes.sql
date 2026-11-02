-- @param {String} $1:actorUri
DELETE FROM mutes WHERE target_actor_uri = $1
