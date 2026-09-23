-- @param {String} $1:accountId
SELECT id, account_id, title, replies_policy, created_at, updated_at
FROM account_lists
WHERE account_id = $1
ORDER BY created_at DESC
