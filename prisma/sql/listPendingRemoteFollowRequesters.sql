-- @param {String} $1:targetAccountId
-- @param {Int} $2:limit
SELECT remote_actor_uri, created_at FROM remote_follows
WHERE target_account_id = $1 AND remote_request_kind = 'Queued'
ORDER BY created_at DESC LIMIT $2
