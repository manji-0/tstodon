-- @param {String} $1:actorUrisJson
-- @param {String} $2:now
UPDATE remote_actors SET refresh_attempted_at = $2
WHERE actor_uri IN (SELECT value FROM json_each($1))
