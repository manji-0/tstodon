-- @param {String} $1:actorUri
-- @param {String} $2:claimedAt
UPDATE remote_actors SET outbox_fetched_at = NULL
WHERE actor_uri = $1 AND outbox_fetched_at = $2
