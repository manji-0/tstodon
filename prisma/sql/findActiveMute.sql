-- @param {String} $1:accountId
-- @param {String} $2:target
-- @param {String} $3:now
SELECT notifications, expires_at FROM mutes
WHERE account_id = $1 AND (target_account_id = $2 OR target_actor_uri = $2)
  AND (expires_at IS NULL OR expires_at > $3)
LIMIT 1
