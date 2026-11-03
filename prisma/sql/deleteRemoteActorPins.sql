-- @param {String} $1:actorUri
DELETE FROM remote_actor_pins WHERE actor_uri = $1
