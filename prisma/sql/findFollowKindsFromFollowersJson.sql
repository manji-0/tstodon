-- @param {String} $1:followerIdsJson
-- @param {String} $2:targetId
SELECT follower_account_id, kind
FROM follows
WHERE follower_account_id IN (SELECT value FROM json_each($1)) AND target_account_id = $2
