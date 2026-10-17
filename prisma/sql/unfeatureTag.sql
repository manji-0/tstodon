-- @param {String} $1:accountId
-- @param {String} $2:tagName
DELETE FROM featured_tags WHERE account_id = $1 AND tag_name = $2
RETURNING tag_name
