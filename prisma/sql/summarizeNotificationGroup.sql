-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {String} $3:notificationId
-- @param {String} $4:groupType
-- @param {String} $5:groupTarget
-- One group by key: its newest visible notification, with the group's count and
-- oldest id. No row when the key names nothing visible. Visibility is
-- `listNotifications`'s; held notifications follow `dismissNotificationGroup`.
WITH members AS (
  SELECT n.id, n.kind, n.from_account_id, n.status_id, n.report_id, n.severance_event_id, n.created_at
  FROM notifications n
  WHERE n.account_id = $1
    AND ($3 <> '' OR $4 <> '')
    AND ($3 = '' OR n.id = $3)
    AND (
      $4 = ''
      OR (
        n.kind = $4
        AND COALESCE(NULLIF(n.status_id, ''), n.from_account_id) = $5
        AND n.id NOT IN (SELECT notification_id FROM notification_requests WHERE account_id = $1)
      )
    )
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
          AND (expires_at IS NULL OR expires_at > $2)
    )
    AND COALESCE(n.from_actor_uri, '') NOT IN (
      SELECT target_actor_uri FROM blocks WHERE blocker_account_id = $1
      UNION
      SELECT target_actor_uri FROM mutes
        WHERE account_id = $1 AND notifications != 0
          AND (expires_at IS NULL OR expires_at > $2)
    )
)
SELECT m.id, m.kind, m.from_account_id, m.status_id, m.report_id, m.severance_event_id, m.created_at,
  (SELECT COUNT(*) FROM members) AS notifications_count,
  (SELECT MIN(id) FROM members) AS oldest_id
FROM members m
ORDER BY m.id DESC
LIMIT 1
