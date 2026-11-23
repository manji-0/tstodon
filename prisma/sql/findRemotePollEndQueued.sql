-- @param {String} $1:statusId
SELECT poll_end_queued_at AS end_queued_at FROM remote_statuses WHERE id = $1
