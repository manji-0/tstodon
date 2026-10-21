-- @param {String} $1:objectUrisJson
SELECT id, object_uri, actor_uri FROM remote_statuses
WHERE object_uri IN (SELECT value FROM json_each($1))
