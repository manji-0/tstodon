-- @param {String} $1:viewerId
-- @param {String} $2:followedAuthorIdsJson
-- @param {String} $3:followedActorUrisJson
-- @param {String} $4:mentionedStatusIdsJson
-- @param {String} $5:directStatusIdsJson
-- @param {String} $6:mentionedRemoteStatusIdsJson
-- What grants the viewer a restricted status, in one statement however many there are:
-- `Follow` rows name the local authors of $2 and `OutboundFollow` rows the remote actors of $3
-- the viewer follows (accepted); `Status` rows name the local statuses of $4 that mention the
-- viewer, and those of the direct notes $5 that the viewer wrote or is mentioned on, or that
-- reply through direct notes only to one the viewer wrote or is mentioned on;
-- `RemoteStatus` rows name the remote statuses of $6 that address the viewer.
WITH RECURSIVE direct_chain(start_id, id) AS (
  SELECT value, value FROM json_each($5)
  UNION
  SELECT direct_chain.start_id, parent.id
  FROM direct_chain
  JOIN statuses AS child ON child.id = direct_chain.id
  JOIN statuses AS parent ON parent.id = child.in_reply_to_id
  WHERE parent.kind = 'LocalNote' AND parent.visibility = 'direct'
)
SELECT 'Follow' AS grant_kind, target_account_id AS grant_key FROM follows
WHERE follower_account_id = $1 AND kind = 'Accepted'
  AND target_account_id IN (SELECT value FROM json_each($2))
UNION ALL
SELECT 'OutboundFollow' AS grant_kind, actor_uri AS grant_key FROM outbound_follows
WHERE account_id = $1 AND state = 'Accepted'
  AND actor_uri IN (SELECT value FROM json_each($3))
UNION ALL
SELECT 'Status' AS grant_kind, status_id AS grant_key FROM status_mentions
WHERE account_id = $1 AND status_id IN (SELECT value FROM json_each($4))
UNION ALL
SELECT DISTINCT 'Status' AS grant_kind, direct_chain.start_id AS grant_key
FROM direct_chain JOIN statuses AS reached ON reached.id = direct_chain.id
WHERE reached.account_id = $1
  OR EXISTS (
    SELECT 1 FROM status_mentions WHERE status_id = reached.id AND account_id = $1
  )
UNION ALL
SELECT 'RemoteStatus' AS grant_kind, status_id AS grant_key FROM remote_status_mentions
WHERE account_id = $1 AND status_id IN (SELECT value FROM json_each($6))
