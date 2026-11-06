-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {String} $3:groupsJson
-- @param {String} $4:suspendedHostsJson
-- @param {String} $5:allowHostsJson
-- @param {String} $6:upperId
-- @param {Int} $7:upperInclusive
-- @param {String} $8:lowerId
-- @param {Int} $9:lowerInclusive
-- Each group of `groupsJson` (`[{"key", "id"}]` for an ungrouped key,
-- `[{"key", "type", "target"}]` for a type and target key) as Mastodon's
-- `load_groups_data`: its newest visible notification, count and three newest
-- distinct senders up to the range's upper end, and its oldest notification
-- from the range's lower end. An empty `upperId` or `lowerId` leaves that end
-- open. Members are found by id, by status or by sender through indexes and
-- read once; a type and target key leaves out held notifications, which
-- Mastodon gives no group key. A group with no visible member has no row.
WITH
groups AS (
  SELECT json_extract(value, '$.key') AS group_key,
    json_extract(value, '$.id') AS notification_id,
    json_extract(value, '$.type') AS type,
    json_extract(value, '$.target') AS target
  FROM json_each($3)
),
candidates AS MATERIALIZED (
  SELECT g.group_key, n.id FROM groups g
    CROSS JOIN notifications n ON n.id = g.notification_id AND n.account_id = $1
  UNION ALL
  SELECT g.group_key, n.id FROM groups g
    CROSS JOIN notifications n ON n.account_id = $1 AND n.status_id = g.target
    WHERE n.kind = g.type AND n.status_id <> ''
  UNION ALL
  SELECT g.group_key, n.id FROM groups g
    CROSS JOIN notifications n ON n.account_id = $1 AND n.from_account_id = g.target
    WHERE n.kind = g.type AND COALESCE(n.status_id, '') = ''
),
members AS MATERIALIZED (
  SELECT c.group_key, n.id, n.from_account_id, n.id IN (SELECT notification_id FROM notification_requests WHERE account_id = $1) AS held
  FROM candidates c CROSS JOIN notifications n ON n.id = c.id
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
          AND ra.host NOT IN (SELECT value FROM json_each($4))
          AND ra.uri_host NOT IN (SELECT value FROM json_each($4))
          AND (json_array_length($5) = 0 OR ra.uri_host IN (SELECT value FROM json_each($5)))
          AND (json_array_length($5) = 0 OR EXISTS (
            SELECT 1 FROM json_each($5) AS allowed
            WHERE allowed.value = lower(ra.domain)
              OR (substr(lower(ra.domain), 1, length(allowed.value) + 1) = allowed.value || ':'
                AND length(ra.domain) > length(allowed.value) + 1
                AND substr(ra.domain, length(allowed.value) + 2) NOT GLOB '*[^0-9]*')
          ))
      )
    )
    AND ($6 = '' OR n.id < $6 OR ($7 = 1 AND n.id = $6))
    AND (c.group_key LIKE 'ungrouped-%' OR NOT n.id IN (SELECT notification_id FROM notification_requests WHERE account_id = $1))
),
counted AS (
  SELECT group_key, COUNT(*) AS notifications_count, MAX(id) AS newest_id,
    MIN(CASE WHEN $8 = '' OR id > $8 OR ($9 = 1 AND id = $8) THEN id END) AS page_min_id
  FROM members GROUP BY group_key
),
senders AS (
  SELECT group_key, from_account_id,
    ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY MAX(id) DESC) AS position
  FROM members GROUP BY group_key, from_account_id
)
SELECT c.group_key, n.id, n.kind, n.from_account_id, n.status_id, n.report_id,
  n.severance_event_id, n.created_at, m.held, c.notifications_count,
  COALESCE(c.page_min_id, n.id) AS page_min_id,
  (SELECT from_account_id FROM senders s WHERE s.group_key = c.group_key AND s.position = 1) AS sample_1,
  (SELECT from_account_id FROM senders s WHERE s.group_key = c.group_key AND s.position = 2) AS sample_2,
  (SELECT from_account_id FROM senders s WHERE s.group_key = c.group_key AND s.position = 3) AS sample_3
FROM counted c
CROSS JOIN notifications n ON n.id = c.newest_id
JOIN members m ON m.group_key = c.group_key AND m.id = c.newest_id
