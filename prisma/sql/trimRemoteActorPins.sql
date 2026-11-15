-- @param {String} $1:actorUri
-- @param {Int} $2:keep
-- Keep the actor's first `keep` pins and drop the rest.
DELETE FROM remote_actor_pins
WHERE actor_uri = $1
  AND status_id NOT IN (
    SELECT status_id FROM remote_actor_pins WHERE actor_uri = $1 ORDER BY position ASC LIMIT $2
  )
