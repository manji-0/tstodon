-- @param {String} $1:accountId
-- @param {Int} $2:limit
SELECT target_account_id FROM follows
WHERE follower_account_id = $1 AND kind = 'Accepted'
ORDER BY created_at DESC LIMIT $2
