-- @param {String} $1:actorUrisJson
SELECT actor_uri, moderation, sensitized FROM remote_actor_moderation
WHERE actor_uri IN (SELECT value FROM json_each($1))
