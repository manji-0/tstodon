-- @param {String} $1:actorUri
DELETE FROM remote_actor_moderation WHERE actor_uri = $1
RETURNING actor_uri
