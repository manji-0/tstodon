-- @param {String} $1:pollId
SELECT id, status_id, multiple, expires_at, options_json FROM polls WHERE id = $1
