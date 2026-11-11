-- @param {String} $1:viewerId
-- @param {String} $2:followedAuthorIdsJson
-- @param {String} $3:followedActorUrisJson
-- @param {String} $4:mentionedStatusIdsJson
-- @param {String} $5:directStatusIdsJson
-- @param {String} $6:mentionedRemoteStatusIdsJson
-- What grants the viewer a restricted status, in one statement however many there are:
-- `Follow` rows name the local authors of $2 and `OutboundFollow` rows the remote actors of $3
-- the viewer follows (accepted); `Status` rows name the local statuses of $4 that mention the
-- viewer; `RemoteStatus` rows name the remote statuses of $6 that address the viewer.
-- The direct notes of $5 and the direct notes they reply through come back once each, however
-- many of $5 share them: `DirectGrant` names one the viewer wrote or is mentioned on, and
-- `DirectReply` one it is not, with `parent_id` the direct note it replies to, if any. The
-- caller walks each note of $5 up those rows, so the chain is read once, not once per note.
-- CROSS JOIN keeps the walk driven from the chain's ids by primary key; the visibility and
-- reply indexes otherwise tempt the planner into scanning every status.
WITH RECURSIVE direct_chain(id) AS (
  SELECT value FROM json_each($5)
  UNION
  SELECT parent.id
  FROM direct_chain
  CROSS JOIN statuses AS child ON child.id = direct_chain.id
  CROSS JOIN statuses AS parent ON parent.id = child.in_reply_to_id
  WHERE parent.kind = 'LocalNote' AND parent.visibility = 'direct'
)
SELECT 'Follow' AS grant_kind, target_account_id AS grant_key, NULL AS parent_id FROM follows
WHERE follower_account_id = $1 AND kind = 'Accepted'
  AND target_account_id IN (SELECT value FROM json_each($2))
UNION ALL
SELECT 'OutboundFollow' AS grant_kind, actor_uri AS grant_key, NULL AS parent_id
FROM outbound_follows
WHERE account_id = $1 AND state = 'Accepted'
  AND actor_uri IN (SELECT value FROM json_each($3))
UNION ALL
SELECT 'Status' AS grant_kind, status_id AS grant_key, NULL AS parent_id FROM status_mentions
WHERE account_id = $1 AND status_id IN (SELECT value FROM json_each($4))
UNION ALL
SELECT
  CASE
    WHEN node.account_id = $1
      OR EXISTS (SELECT 1 FROM status_mentions WHERE status_id = node.id AND account_id = $1)
    THEN 'DirectGrant'
    ELSE 'DirectReply'
  END AS grant_kind,
  node.id AS grant_key,
  parent.id AS parent_id
FROM direct_chain
CROSS JOIN statuses AS node ON node.id = direct_chain.id
LEFT JOIN statuses AS parent ON parent.id = node.in_reply_to_id
  AND parent.kind = 'LocalNote' AND parent.visibility = 'direct'
UNION ALL
SELECT 'RemoteStatus' AS grant_kind, status_id AS grant_key, NULL AS parent_id
FROM remote_status_mentions
WHERE account_id = $1 AND status_id IN (SELECT value FROM json_each($6))
