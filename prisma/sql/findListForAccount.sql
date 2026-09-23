-- @param {String} $1:listId
-- @param {String} $2:accountId
SELECT id, account_id, title, replies_policy, created_at, updated_at
FROM account_lists
WHERE id = $1 AND account_id = $2
