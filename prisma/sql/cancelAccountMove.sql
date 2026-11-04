-- @param {String} $1:accountId
-- @param {String} $2:cancelledAt
UPDATE account_moves SET cancelled_at = $2
WHERE account_id = $1 AND cancelled_at IS NULL
RETURNING account_id
