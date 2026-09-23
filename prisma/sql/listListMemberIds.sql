-- @param {String} $1:listId
SELECT member_account_id
FROM account_list_members
WHERE list_id = $1
ORDER BY created_at ASC
