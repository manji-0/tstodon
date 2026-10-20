-- @param {String} $1:followerId
-- @param {String} $2:targetId
-- @param {Int} $3:reblogs
-- @param {Int} $4:notify
-- @param {String} $5:languagesJson
UPDATE follows SET reblogs = $3, notify = $4, languages_json = $5
WHERE follower_account_id = $1 AND target_account_id = $2
