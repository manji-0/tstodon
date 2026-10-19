-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {Int} $3:limit
-- @param {String} $4:typesJson
-- @param {String} $5:excludeTypesJson
-- @param {String} $6:fromAccountId
-- @param {String} $7:maxId
SELECT n.id, n.account_id, n.from_account_id, n.kind, n.status_id, n.created_at
FROM notifications n
WHERE n.account_id = $1
  AND n.created_at > COALESCE(
    (SELECT cleared_at FROM notification_clear_markers WHERE account_id = $1), ''
  )
  AND n.id NOT IN (
    SELECT notification_id FROM notification_dismissals WHERE account_id = $1
  )
  AND n.id NOT IN (
    SELECT notification_id FROM notification_requests WHERE account_id = $1
  )
  AND ($4 = '[]' OR n.kind IN (SELECT value FROM json_each($4)))
  AND ($5 = '[]' OR n.kind NOT IN (SELECT value FROM json_each($5)))
  AND ($6 = '' OR n.from_account_id = $6)
  AND ($7 = '' OR n.id < $7)
  AND n.from_account_id NOT IN (
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
ORDER BY n.id DESC LIMIT $3
