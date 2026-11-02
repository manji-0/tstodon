-- @param {String} $1:statusId
UPDATE remote_poll_own_votes SET optimistic = 0 WHERE status_id = $1 AND optimistic = 1
