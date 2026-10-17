-- @param {String} $1:pollId
SELECT COUNT(*) AS count FROM poll_votes WHERE poll_id = $1
