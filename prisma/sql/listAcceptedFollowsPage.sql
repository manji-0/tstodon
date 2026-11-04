-- @param {String} $1:targetAccountId
-- @param {String} $2:afterId
-- @param {Int} $3:limit
SELECT id, follower_account_id, reblogs, notify, languages_json FROM follows
WHERE target_account_id = $1 AND kind = 'Accepted' AND id > $2 ORDER BY id LIMIT $3
