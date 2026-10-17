-- @param {String} $1:idsJson
SELECT id, in_reply_to_id FROM statuses WHERE id IN (SELECT value FROM json_each($1))
