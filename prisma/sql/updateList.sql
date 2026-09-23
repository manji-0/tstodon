-- @param {String} $1:title
-- @param {String} $2:repliesPolicy
-- @param {String} $3:updatedAt
-- @param {String} $4:listId
-- @param {String} $5:accountId
UPDATE account_lists
SET title = $1, replies_policy = $2, updated_at = $3
WHERE id = $4 AND account_id = $5
