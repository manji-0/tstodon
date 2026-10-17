-- @param {String} $1:targetAccountId
-- @param {Int} $2:limit
SELECT follower_account_id, created_at FROM follows
WHERE target_account_id = $1 AND kind = 'Pending'
ORDER BY created_at DESC LIMIT $2
