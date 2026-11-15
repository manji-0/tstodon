-- @param {String} $1:actorUri
-- @param {String} $2:objectUri
DELETE FROM remote_actor_pins
WHERE actor_uri = $1
  AND status_id IN (SELECT id FROM remote_statuses WHERE object_uri = $2 AND actor_uri = $1)
