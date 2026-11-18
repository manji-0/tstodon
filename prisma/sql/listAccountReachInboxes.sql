-- @param {String} $1:accountId
-- @param {String} $2:since
-- @param {Int} $3:limit
-- The inboxes beyond its followers' that may hold a copy of a local account,
-- as Mastodon's `AccountReachFinder`: the remote actors that reported it,
-- those its latest 200 statuses since $2 mention, and those it followed or
-- asked to follow since $2. A shared inbox stands for its actors. Leaves out
-- the actors an admin suspended.
SELECT DISTINCT COALESCE(a.shared_inbox_uri, a.inbox_uri) AS inbox_uri
FROM (
  SELECT reporter_actor_uri AS actor_uri FROM reports
  WHERE target_account_id = $1 AND reporter_actor_uri IS NOT NULL
  UNION
  SELECT actor_uri FROM status_remote_mentions
  WHERE status_id IN (
    SELECT id FROM statuses WHERE account_id = $1 AND created_at >= $2
    ORDER BY created_at DESC LIMIT 200
  )
  UNION
  SELECT actor_uri FROM outbound_follows WHERE account_id = $1 AND created_at >= $2
) i
JOIN remote_actors a ON a.actor_uri = i.actor_uri
WHERE i.actor_uri NOT IN (SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended')
LIMIT $3
