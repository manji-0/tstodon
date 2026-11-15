-- @param {String} $1:actorUri
-- @param {String} $2:tagName
-- @param {String} $3:name
-- @param {Int} $4:position
INSERT OR IGNORE INTO remote_featured_tags (actor_uri, tag_name, name, position) VALUES ($1, $2, $3, $4)
