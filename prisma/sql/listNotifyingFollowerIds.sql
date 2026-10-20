-- @param {String} $1:accountId
SELECT follower_account_id FROM follows
WHERE target_account_id = $1 AND follower_account_id != $1 AND kind = 'Accepted' AND notify != 0
