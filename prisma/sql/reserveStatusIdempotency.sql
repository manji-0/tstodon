-- @param {String} $1:accountId
-- @param {String} $2:idempotencyKey
-- @param {String} $3:now
INSERT INTO status_idempotency (account_id, idempotency_key, status_id, created_at)
VALUES ($1, $2, '', $3)
ON CONFLICT(account_id, idempotency_key) DO NOTHING
RETURNING idempotency_key
