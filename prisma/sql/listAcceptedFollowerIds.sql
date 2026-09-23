-- @param {String} $1:targetAccountId
SELECT follower_account_id FROM follows
WHERE target_account_id = $1 AND kind = 'Accepted'
