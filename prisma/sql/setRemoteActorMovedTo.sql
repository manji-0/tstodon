-- @param {String} $1:actorUri
-- @param {String} $2:movedTo
UPDATE remote_actors SET moved_to = $2 WHERE actor_uri = $1
