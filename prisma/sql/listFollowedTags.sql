-- @param {String} $1:accountId
SELECT tag_name FROM followed_tags WHERE account_id = $1 ORDER BY created_at DESC, tag_name ASC
