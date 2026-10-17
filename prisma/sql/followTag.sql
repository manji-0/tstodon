-- @param {String} $1:accountId
-- @param {String} $2:tagName
-- @param {String} $3:createdAt
INSERT INTO followed_tags (account_id, tag_name, created_at)
VALUES ($1, $2, $3)
ON CONFLICT(account_id, tag_name) DO NOTHING
