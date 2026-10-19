-- @param {Int} $1:locked
-- @param {String} $2:accountId
UPDATE accounts SET locked = $1 WHERE id = $2
RETURNING id
