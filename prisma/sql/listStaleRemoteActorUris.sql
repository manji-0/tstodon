-- @param {String} $1:before
-- @param {Int} $2:limit
SELECT actor_uri FROM remote_actors
WHERE fetched_at <= $1
ORDER BY random()
LIMIT $2
