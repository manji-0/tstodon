-- @param {String} $1:accountId
-- @param {String} $2:idempotencyKey
-- @param {String} $3:statusId
UPDATE status_idempotency SET status_id = $3
WHERE account_id = $1 AND idempotency_key = $2 AND status_id = ''
RETURNING idempotency_key
