-- @param {String} $1:statusId
SELECT poll_fetched_at FROM remote_statuses WHERE id = $1
