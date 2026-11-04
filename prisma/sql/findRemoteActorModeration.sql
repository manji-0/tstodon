-- @param {String} $1:actorUri
SELECT moderation, sensitized FROM remote_actor_moderation WHERE actor_uri = $1 LIMIT 1
