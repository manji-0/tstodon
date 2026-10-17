-- @param {String} $1:accountId
-- @param {String} $2:markerId
-- @param {String} $3:now
SELECT COUNT(*) AS count FROM notifications n
WHERE n.account_id = $1
  AND n.id > $2
  AND n.created_at > COALESCE(
    (SELECT cleared_at FROM notification_clear_markers WHERE account_id = $1), ''
  )
  AND n.id NOT IN (
    SELECT notification_id FROM notification_dismissals WHERE account_id = $1
  )
  AND n.from_account_id NOT IN (
    SELECT target_account_id FROM blocks
      WHERE blocker_account_id = $1 AND target_account_id IS NOT NULL
    UNION
    SELECT blocker_account_id FROM blocks
      WHERE target_account_id = $1 AND blocker_account_id IS NOT NULL
    UNION
    SELECT target_account_id FROM mutes
      WHERE account_id = $1 AND target_account_id IS NOT NULL AND notifications != 0
        AND (expires_at IS NULL OR expires_at > $3)
  )
