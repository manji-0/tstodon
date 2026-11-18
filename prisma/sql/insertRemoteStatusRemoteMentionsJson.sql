-- @param {String} $1:statusId
-- @param {String} $2:actorUrisJson
INSERT OR IGNORE INTO remote_status_remote_mentions (status_id, actor_uri)
SELECT $1, value FROM json_each($2) ORDER BY key
