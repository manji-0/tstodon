-- @param {String} $1:accountId
-- @param {String} $2:idempotencyKey
-- @param {String} $3:since
SELECT status_id FROM status_idempotency
WHERE account_id = $1 AND idempotency_key = $2 AND created_at > $3
LIMIT 1
