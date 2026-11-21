-- @param {String} $1:statusId
-- @param {String} $2:actorUrisJson
-- A silent mention never replaces one the note already addressed them with.
INSERT OR IGNORE INTO status_remote_mentions (status_id, actor_uri, silent)
SELECT $1, value, 1 FROM json_each($2) ORDER BY key
