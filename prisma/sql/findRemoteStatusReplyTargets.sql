-- @param {String} $1:idsJson
SELECT id, object_uri, visibility, in_reply_to_uri FROM remote_statuses
WHERE id IN (SELECT value FROM json_each($1))
