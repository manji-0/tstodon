-- @param {String} $1:title
-- @param {String} $2:repliesPolicy
-- @param {Int} $3:exclusive
-- @param {String} $4:updatedAt
-- @param {String} $5:listId
-- @param {String} $6:accountId
UPDATE account_lists
SET title = $1, replies_policy = $2, exclusive = $3, updated_at = $4
WHERE id = $5 AND account_id = $6
