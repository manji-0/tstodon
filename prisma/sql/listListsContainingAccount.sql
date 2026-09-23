-- @param {String} $1:ownerAccountId
-- @param {String} $2:memberAccountId
SELECT l.id, l.account_id, l.title, l.replies_policy, l.created_at, l.updated_at
FROM account_lists l
JOIN account_list_members m ON m.list_id = l.id
WHERE l.account_id = $1 AND m.member_account_id = $2
ORDER BY l.created_at DESC
