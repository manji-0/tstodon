-- @param {String} $1:pollId
-- @param {String} $2:optionsJson
-- @param {Int} $3:multiple
-- @param {String} $4:expiresAt
UPDATE polls SET options_json = $2, multiple = $3, expires_at = $4
WHERE id = $1
RETURNING id
