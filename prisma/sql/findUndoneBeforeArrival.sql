-- @param {String} $1:actorUri
-- @param {String} $2:activityUri
-- @param {String} $3:undoneAfter
SELECT 1 AS present FROM undone_before_arrival
WHERE actor_uri = $1 AND activity_uri = $2 AND created_at > $3
LIMIT 1
