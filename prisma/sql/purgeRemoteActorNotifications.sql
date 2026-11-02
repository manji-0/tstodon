-- @param {String} $1:actorUri
DELETE FROM notifications WHERE from_actor_uri = $1
