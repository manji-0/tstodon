-- @param {String} $1:statusId
SELECT COUNT(*) AS count FROM remote_favourites WHERE status_id = $1
