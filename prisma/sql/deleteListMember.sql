-- @param {String} $1:listId
-- @param {String} $2:memberAccountId
DELETE FROM account_list_members WHERE list_id = $1 AND member_account_id = $2
