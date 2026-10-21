-- @param {String} $1:statusId
-- @param {String} $2:actorUri
INSERT OR IGNORE INTO status_remote_mentions (status_id, actor_uri) VALUES ($1, $2)
