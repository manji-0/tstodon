-- @param {String} $1:domain
-- @param {String} $2:now
UPDATE remote_statuses SET media_json = '[]', updated_at = $2
-- The actors on the domain: its account domain or the host of its URI.
WHERE actor_uri IN (SELECT actor_uri FROM remote_actors WHERE host = $1 OR uri_host = $1)
