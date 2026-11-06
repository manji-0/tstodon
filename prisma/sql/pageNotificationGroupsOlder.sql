-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {Int} $3:limit
-- @param {String} $4:typesJson
-- @param {String} $5:excludeTypesJson
-- @param {String} $6:fromAccountId
-- @param {Int} $7:includeFiltered
-- @param {String} $8:groupedTypesJson
-- @param {String} $9:suspendedHostsJson
-- @param {String} $10:allowHostsJson
-- @param {String} $11:maxId
-- @param {String} $12:sinceId
-- The representative of each of the first `limit` groups below `max_id` (and
-- above `since_id`), newest first: the newest visible notification of each
-- group not met yet, as Mastodon's `paginate_groups` reading `:desc`.
-- Each step seeks the next notification whose key is not among the keys met,
-- so a long run of one group costs one statement, not one request per row.
-- The key is `NotificationGroup.key`'s.
WITH RECURSIVE
candidates(id, group_key) AS NOT MATERIALIZED (
  SELECT n.id,
    CASE
      WHEN n.kind IN (SELECT value FROM json_each($8)) AND NOT n.id IN (SELECT notification_id FROM notification_requests WHERE account_id = $1)
        THEN n.kind || '-' || COALESCE(NULLIF(n.status_id, ''), n.from_account_id)
      ELSE 'ungrouped-' || n.id
    END
  FROM notifications n
  WHERE n.account_id = $1
    AND +n.created_at > COALESCE(
      (SELECT cleared_at FROM notification_clear_markers WHERE account_id = $1), ''
    )
    AND n.id NOT IN (SELECT notification_id FROM notification_dismissals WHERE account_id = $1)
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
    -- The sender is available, as `availableAccountIds` decides it.
    AND (
      EXISTS (
        SELECT 1 FROM accounts a
        WHERE a.id = n.from_account_id
          AND a.id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')
      )
      OR EXISTS (
        SELECT 1 FROM remote_actors ra
        WHERE ra.actor_uri = n.from_actor_uri
          AND ra.actor_uri NOT IN (
            SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended'
          )
          AND ra.host NOT IN (SELECT value FROM json_each($9))
          AND ra.uri_host NOT IN (SELECT value FROM json_each($9))
          AND (json_array_length($10) = 0 OR ra.uri_host IN (SELECT value FROM json_each($10)))
          AND (json_array_length($10) = 0 OR EXISTS (
            SELECT 1 FROM json_each($10) AS allowed
            WHERE allowed.value = lower(ra.domain)
              OR (substr(lower(ra.domain), 1, length(allowed.value) + 1) = allowed.value || ':'
                AND length(ra.domain) > length(allowed.value) + 1
                AND substr(ra.domain, length(allowed.value) + 2) NOT GLOB '*[^0-9]*')
          ))
      )
    )
    AND ($7 = 1 OR NOT n.id IN (SELECT notification_id FROM notification_requests WHERE account_id = $1))
    AND ($4 = '[]' OR n.kind IN (SELECT value FROM json_each($4)))
    AND ($5 = '[]' OR n.kind NOT IN (SELECT value FROM json_each($5)))
    AND ($6 = '' OR n.from_account_id = $6)
    AND n.id < COALESCE(NULLIF($11, ''), '~')
    AND n.id > $12
),
-- `entry` is a notification's `id group_key` (an id holds no space); `met`
-- the keys of the entries before it.
walk(entry, met, depth) AS (
  SELECT (SELECT id || ' ' || group_key FROM candidates ORDER BY id DESC LIMIT 1), json_array(), 1
  WHERE $3 > 0
  UNION ALL
  SELECT (
      SELECT next.id || ' ' || next.group_key FROM candidates next
      WHERE next.id < substr(w.entry, 1, instr(w.entry, ' ') - 1)
        AND next.group_key <> substr(w.entry, instr(w.entry, ' ') + 1)
        AND next.group_key NOT IN (SELECT value FROM json_each(w.met))
      ORDER BY next.id DESC
      LIMIT 1
    ),
    json_insert(w.met, '$[#]', substr(w.entry, instr(w.entry, ' ') + 1)),
    w.depth + 1
  FROM walk w
  WHERE w.entry IS NOT NULL AND w.depth < $3
)
SELECT substr(entry, 1, instr(entry, ' ') - 1) AS id, substr(entry, instr(entry, ' ') + 1) AS group_key
FROM walk
WHERE entry IS NOT NULL
ORDER BY id DESC
