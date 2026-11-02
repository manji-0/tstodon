-- @param {String} $1:actorUri
DELETE FROM remote_actors WHERE actor_uri = $1
RETURNING actor_uri
