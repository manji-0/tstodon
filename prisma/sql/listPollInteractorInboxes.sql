-- The inboxes of the remote actors that voted on a local status's poll or,
-- when the status is public or unlisted, boosted it, as Mastodon's
-- `StatusReachFinder`. Leaves out the actors an admin suspended and those
-- the author blocks.
-- @param {String} $1:statusId
SELECT DISTINCT COALESCE(a.shared_inbox_uri, a.inbox_uri) AS inbox_uri
FROM statuses s
JOIN (
  SELECT p.status_id, v.actor_uri
  FROM remote_poll_votes v
  JOIN polls p ON p.id = v.poll_id
  WHERE p.status_id = $1
  UNION
  SELECT r.status_id, r.remote_actor_uri AS actor_uri
  FROM remote_announces r
  JOIN statuses boosted ON boosted.id = r.status_id
  WHERE r.status_id = $1 AND boosted.visibility IN ('public', 'unlisted')
) i ON i.status_id = s.id
JOIN remote_actors a ON a.actor_uri = i.actor_uri
WHERE s.id = $1
  AND i.actor_uri NOT IN (SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended')
  AND i.actor_uri NOT IN (SELECT target_actor_uri FROM blocks WHERE blocker_account_id = s.account_id)
