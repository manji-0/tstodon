-- @param {String} $1:targetAccountId
-- @param {String} $2:followerAccountId
DELETE FROM follows
WHERE target_account_id = $1 AND follower_account_id = $2 AND kind = 'Pending'
RETURNING follower_account_id
