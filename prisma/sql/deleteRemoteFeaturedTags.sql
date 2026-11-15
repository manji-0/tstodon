-- @param {String} $1:actorUri
DELETE FROM remote_featured_tags WHERE actor_uri = $1
