-- @param {String} $1:targetAccountId
-- @param {Int} $2:limit
SELECT remote_actor_uri FROM remote_follows
WHERE target_account_id = $1 AND follow_kind = 'Accepted'
ORDER BY created_at DESC LIMIT $2
