-- The inboxes of the remote actors that voted on or boosted a public or
-- unlisted local status's poll, as Mastodon's `StatusReachFinder`. A
-- followers-only or direct poll reaches only its addressing: its legitimate
-- voters are followers or mentioned, and a voter who lost that access, or
-- voted before an edit narrowed the audience, must not hear it. Leaves out
-- the actors an admin suspended and those the author blocks.
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
  WHERE r.status_id = $1
) i ON i.status_id = s.id
JOIN remote_actors a ON a.actor_uri = i.actor_uri
WHERE s.id = $1
  AND s.visibility IN ('public', 'unlisted')
  AND i.actor_uri NOT IN (SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended')
  AND i.actor_uri NOT IN (SELECT target_actor_uri FROM blocks WHERE blocker_account_id = s.account_id)
