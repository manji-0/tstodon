-- @param {String} $1:accountId
-- @param {Int} $2:limit
SELECT follower_account_id FROM follows
WHERE target_account_id = $1 AND kind = 'Accepted'
ORDER BY created_at DESC LIMIT $2
