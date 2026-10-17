-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {Int} $3:limit
SELECT target_account_id, target_actor_uri, notifications, expires_at, created_at FROM mutes
WHERE account_id = $1 AND target_account_id IS NOT NULL
  AND (expires_at IS NULL OR expires_at > $2)
ORDER BY created_at DESC LIMIT $3
