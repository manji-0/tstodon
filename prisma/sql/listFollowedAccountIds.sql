-- @param {String} $1:followerId
-- @param {String} $2:targetIdsJson
SELECT target_account_id FROM follows
WHERE follower_account_id = $1 AND kind = 'Accepted'
  AND target_account_id IN (SELECT value FROM json_each($2))
