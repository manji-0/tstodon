-- @param {String} $1:actorUri
-- @param {String} $2:statusId
-- @param {Int} $3:position
INSERT OR IGNORE INTO remote_actor_pins (actor_uri, status_id, position) VALUES ($1, $2, $3)
