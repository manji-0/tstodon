-- @param {Int} $1:limit
-- The actors fetched since their profile's links were last looked at,
-- the longest waiting first.
SELECT actor_uri, profile_json, fetched_at
FROM remote_actors
WHERE links_checked_at IS NULL OR links_checked_at < fetched_at
ORDER BY fetched_at
LIMIT $1
