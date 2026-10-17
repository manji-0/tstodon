-- @param {String} $1:accountId
-- @param {String} $2:tagName
SELECT tag_name FROM followed_tags WHERE account_id = $1 AND tag_name = $2 LIMIT 1
