-- @param {String} $1:statusId
SELECT snapshot_json, created_at FROM status_edits
WHERE status_id = $1
ORDER BY created_at DESC, id DESC
