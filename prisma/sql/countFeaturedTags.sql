-- @param {String} $1:accountId
SELECT COUNT(*) AS count FROM featured_tags WHERE account_id = $1
