-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {Int} $3:limit
SELECT id, account_id, from_account_id, kind, status_id, created_at
FROM notifications
WHERE account_id = $1
  AND from_account_id NOT IN (
    SELECT target_account_id FROM blocks
      WHERE blocker_account_id = $1 AND target_account_id IS NOT NULL
    UNION
    SELECT blocker_account_id FROM blocks
      WHERE target_account_id = $1 AND blocker_account_id IS NOT NULL
    UNION
    SELECT target_account_id FROM mutes
      WHERE account_id = $1 AND target_account_id IS NOT NULL AND notifications != 0
        AND (expires_at IS NULL OR expires_at > $2)
  )
ORDER BY id DESC LIMIT $3
