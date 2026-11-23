-- @param {String} $1:pollId
SELECT end_queued_at FROM polls WHERE id = $1
