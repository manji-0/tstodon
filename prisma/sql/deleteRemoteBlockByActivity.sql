-- @param {String} $1:actorUri
-- @param {String} $2:activityUri
DELETE FROM remote_blocks WHERE actor_uri = $1 AND activity_uri = $2
