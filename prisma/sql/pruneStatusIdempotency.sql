-- @param {String} $1:accountId
-- @param {String} $2:before
DELETE FROM status_idempotency
WHERE account_id = $1 AND created_at <= $2
