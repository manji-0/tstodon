-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {Int} $3:limit
-- @param {String} $4:typesJson
-- @param {String} $5:excludeTypesJson
-- @param {String} $6:fromAccountId
-- @param {String} $7:cursorId
-- @param {Int} $8:cursorGreaterThan
-- @param {Int} $9:ascending
-- @param {Int} $10:includeFiltered
SELECT n.id, n.account_id, n.from_account_id, n.kind, n.status_id, n.created_at
FROM notifications n
WHERE n.account_id = $1
  AND n.created_at > COALESCE(
    (SELECT cleared_at FROM notification_clear_markers WHERE account_id = $1), ''
  )
  AND n.id NOT IN (
    SELECT notification_id FROM notification_dismissals WHERE account_id = $1
  )
  AND (
    $10 = 1
    OR n.id NOT IN (SELECT notification_id FROM notification_requests WHERE account_id = $1)
  )
  AND ($4 = '[]' OR n.kind IN (SELECT value FROM json_each($4)))
  AND ($5 = '[]' OR n.kind NOT IN (SELECT value FROM json_each($5)))
  AND ($6 = '' OR n.from_account_id = $6)
  AND (
    $7 = ''
    OR ($8 = 1 AND n.id > $7)
    OR ($8 = 0 AND n.id < $7)
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
-- One CASE key is NULL for every row in each mode, so the other decides the
-- direction: `min_id` pages upward, everything else newest first.
ORDER BY (CASE WHEN $9 = 1 THEN n.id END) ASC, (CASE WHEN $9 = 0 THEN n.id END) DESC
LIMIT $3
