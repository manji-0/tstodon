-- @param {String} $1:id
DELETE FROM accounts WHERE id = $1
RETURNING id
