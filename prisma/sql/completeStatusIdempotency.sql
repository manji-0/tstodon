-- @param {String} $1:accountId
-- @param {String} $2:idempotencyKey
-- @param {String} $3:kind
-- @param {String} $4:statusId
UPDATE status_idempotency SET kind = $3, status_id = $4
WHERE account_id = $1 AND idempotency_key = $2 AND kind = 'Pending'
RETURNING idempotency_key
