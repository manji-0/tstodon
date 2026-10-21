-- @param {String} $1:objectUri
-- @param {String} $2:actorUri
DELETE FROM remote_statuses WHERE object_uri = $1 AND actor_uri = $2
RETURNING id
