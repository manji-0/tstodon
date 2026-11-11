-- @param {String} $1:accountId
-- @param {String} $2:targetsJson
-- @param {String} $3:now
SELECT target_account_id, target_actor_uri, notifications, expires_at FROM mutes
WHERE account_id = $1
  AND (target_account_id IN (SELECT value FROM json_each($2))
    OR target_actor_uri IN (SELECT value FROM json_each($2)))
  AND (expires_at IS NULL OR expires_at > $3)
