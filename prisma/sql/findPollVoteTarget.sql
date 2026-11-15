-- @param {String} $1:pollId
SELECT options_json, expires_at, multiple FROM polls WHERE id = $1
