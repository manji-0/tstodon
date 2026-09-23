-- @param {String} $1:statusId
SELECT id, status_id, multiple, expires_at, options_json FROM polls WHERE status_id = $1
