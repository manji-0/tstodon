-- @param {String} $1:actorUri
-- @param {String} $2:before
-- @param {String} $3:now
-- Mark the actor's key refetched now unless it was refetched after `before`,
-- so concurrent failed verifications refetch it once per window. Returns the
-- row when this claim took it.
UPDATE remote_actors SET key_refetched_at = $3
WHERE actor_uri = $1 AND coalesce(key_refetched_at, '') <= $2
RETURNING actor_uri
