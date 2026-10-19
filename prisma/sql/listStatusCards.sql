-- @param {String} $1:idsJson
SELECT id, card_json FROM statuses
WHERE card_json IS NOT NULL AND id IN (SELECT value FROM json_each($1))
