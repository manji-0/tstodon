-- @param {String} $1:idsJson
SELECT id, in_reply_to_uri FROM statuses
WHERE id IN (SELECT value FROM json_each($1)) AND in_reply_to_uri IS NOT NULL
