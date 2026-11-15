-- @param {String} $1:targetAccountId
-- @param {String} $2:followerAccountId
-- @param {String} $3:acceptedAt
UPDATE follows SET kind = 'Accepted', created_at = $3
WHERE target_account_id = $1 AND follower_account_id = $2 AND kind = 'Pending'
RETURNING follower_account_id
