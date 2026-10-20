-- @param {String} $1:followerId
-- @param {String} $2:targetId
SELECT kind, reblogs, notify, languages_json
FROM follows WHERE follower_account_id = $1 AND target_account_id = $2
