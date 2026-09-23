-- @param {String} $1:statusId
SELECT COUNT(*) AS count FROM remote_announces WHERE status_id = $1
