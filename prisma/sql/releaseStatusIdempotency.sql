-- @param {String} $1:accountId
-- @param {String} $2:idempotencyKey
DELETE FROM status_idempotency
WHERE account_id = $1 AND idempotency_key = $2
RETURNING idempotency_key
