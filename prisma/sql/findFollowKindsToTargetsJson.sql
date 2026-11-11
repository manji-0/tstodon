-- @param {String} $1:followerId
-- @param {String} $2:targetIdsJson
SELECT target_account_id, kind, reblogs, notify, languages_json
FROM follows
WHERE follower_account_id = $1 AND target_account_id IN (SELECT value FROM json_each($2))
