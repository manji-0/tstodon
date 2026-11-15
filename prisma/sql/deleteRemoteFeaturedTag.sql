-- @param {String} $1:actorUri
-- @param {String} $2:tagName
DELETE FROM remote_featured_tags WHERE actor_uri = $1 AND tag_name = $2
