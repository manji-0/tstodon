-- @param {String} $1:pollId
SELECT options_json, expires_at FROM polls WHERE id = $1
