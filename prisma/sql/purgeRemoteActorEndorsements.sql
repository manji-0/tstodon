-- @param {String} $1:actorUri
DELETE FROM endorsements WHERE target_actor_uri = $1
