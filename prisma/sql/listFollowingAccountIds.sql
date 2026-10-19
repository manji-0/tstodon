-- @param {String} $1:accountId
SELECT target_account_id FROM follows
WHERE follower_account_id = $1 AND kind = 'Accepted'
