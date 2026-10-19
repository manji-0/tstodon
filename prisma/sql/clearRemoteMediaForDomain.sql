-- @param {String} $1:domain
-- @param {String} $2:now
UPDATE remote_statuses SET media_json = '[]', updated_at = $2
WHERE actor_uri IN (SELECT actor_uri FROM remote_actors WHERE domain = $1)
