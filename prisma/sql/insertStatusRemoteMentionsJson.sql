-- @param {String} $1:statusId
-- @param {String} $2:actorUrisJson
-- A real mention promotes a silent one. One statement however many actors,
-- in the order the note names them.
INSERT INTO status_remote_mentions (status_id, actor_uri, silent)
SELECT $1, value, 0 FROM json_each($2) WHERE true ORDER BY key
ON CONFLICT(status_id, actor_uri) DO UPDATE SET silent = 0
