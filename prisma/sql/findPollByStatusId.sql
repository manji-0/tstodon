-- @param {String} $1:statusId
SELECT id, status_id, multiple, expires_at, options_json, hide_totals FROM polls WHERE status_id = $1
