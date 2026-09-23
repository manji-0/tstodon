-- @param {String} $1:optionsJson
-- @param {String} $2:pollId
-- @param {String} $3:now
UPDATE polls SET options_json = $1 WHERE id = $2 AND expires_at > $3
