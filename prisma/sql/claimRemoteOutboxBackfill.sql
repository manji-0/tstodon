-- @param {String} $1:claimedAt
-- @param {String} $2:actorUri
-- @param {String} $3:staleBefore
UPDATE remote_actors SET outbox_fetched_at = $1
WHERE actor_uri = $2 AND (outbox_fetched_at IS NULL OR outbox_fetched_at < $3)
RETURNING actor_uri
