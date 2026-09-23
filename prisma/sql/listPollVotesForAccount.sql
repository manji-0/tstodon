-- @param {String} $1:pollId
-- @param {String} $2:accountId
SELECT option_index FROM poll_votes WHERE poll_id = $1 AND account_id = $2
