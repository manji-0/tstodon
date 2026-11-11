-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {Int} $3:limit
-- @param {String} $4:typesJson
-- @param {String} $5:excludeTypesJson
-- @param {String} $6:fromAccountId
-- @param {String} $7:minId
-- @param {Int} $8:includeFiltered
-- @param {String} $9:notificationId
-- @param {String} $10:groupType
-- @param {String} $11:groupTarget
SELECT n.id, n.account_id, n.from_account_id, n.kind, n.status_id, n.target_account_id, n.report_id, n.severance_event_id, n.created_at,
  n.id IN (SELECT notification_id FROM notification_requests WHERE account_id = $1) AS held
FROM notifications n
WHERE n.account_id = $1
  -- Unary + keeps the planner off the created_at index, so it walks
  -- (account_id, id) in the page order instead of sorting every notification.
  AND +n.created_at > COALESCE(
    (SELECT cleared_at FROM notification_clear_markers WHERE account_id = $1), ''
  )
  AND n.id NOT IN (
    SELECT notification_id FROM notification_dismissals WHERE account_id = $1
  )
  AND (
    $8 = 1
    OR n.id NOT IN (SELECT notification_id FROM notification_requests WHERE account_id = $1)
  )
  AND ($4 = '[]' OR n.kind IN (SELECT value FROM json_each($4)))
  AND ($5 = '[]' OR n.kind NOT IN (SELECT value FROM json_each($5)))
  AND ($6 = '' OR n.from_account_id = $6)
  -- A group key's notifications, as `NotificationGroup.key` builds it.
  AND ($9 = '' OR n.id = $9)
  AND (
    $10 = ''
    OR (n.kind = $10 AND COALESCE(NULLIF(n.status_id, ''), n.from_account_id) = $11)
  )
  AND n.id > $7
  AND n.from_account_id NOT IN (
    SELECT target_account_id FROM blocks
      WHERE blocker_account_id = $1 AND target_account_id IS NOT NULL
    UNION ALL
    SELECT blocker_account_id FROM blocks
      WHERE target_account_id = $1 AND blocker_account_id IS NOT NULL
    UNION ALL
    SELECT target_account_id FROM mutes
      WHERE account_id = $1 AND target_account_id IS NOT NULL AND notifications != 0
        AND (expires_at IS NULL OR expires_at > $2)
  )
  -- Remote senders are blocked and muted by actor URI.
  AND COALESCE(n.from_actor_uri, '') NOT IN (
    SELECT target_actor_uri FROM blocks WHERE blocker_account_id = $1
    UNION ALL
    SELECT target_actor_uri FROM mutes
      WHERE account_id = $1 AND notifications != 0
        AND (expires_at IS NULL OR expires_at > $2)
  )
ORDER BY n.id ASC
LIMIT $3
