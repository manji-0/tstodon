-- @param {String} $1:pollId
-- @param {String} $2:statusId
UPDATE statuses SET poll_id = $1 WHERE id = $2
