-- @param {String} $1:listId
-- @param {String} $2:accountId
DELETE FROM account_lists WHERE id = $1 AND account_id = $2
RETURNING id
