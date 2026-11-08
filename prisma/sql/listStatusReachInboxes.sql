-- @param {String} $1:localStatusId
-- @param {String} $2:remoteStatusId
-- @param {String} $3:statusUri
-- The inboxes of the remote actors a status reached, as Mastodon's
-- `StatusReachFinder` with `unsafe: true` (the reach `RevokeQuoteService`
-- withdraws a stamp from): the actors a local status mentions, the actors
-- that boosted or favourited it, and the authors of cached replies to it.
-- One of $1 (a local status) and $2 (a remote status) is '' and matches
-- nothing; $3 is the status's URI. A shared inbox stands for its actors.
-- Leaves out the actors an admin suspended.
SELECT DISTINCT COALESCE(a.shared_inbox_uri, a.inbox_uri) AS inbox_uri
FROM (
  SELECT actor_uri FROM status_remote_mentions WHERE status_id = $1
  UNION
  SELECT remote_actor_uri AS actor_uri FROM remote_announces WHERE status_id = $1
  UNION
  SELECT remote_actor_uri AS actor_uri FROM remote_favourites WHERE status_id = $1
  UNION
  SELECT actor_uri FROM remote_boosts
  WHERE (local_status_id = $1 AND $1 <> '') OR (remote_status_id = $2 AND $2 <> '')
  UNION
  SELECT actor_uri FROM remote_statuses WHERE in_reply_to_uri = $3
) i
JOIN remote_actors a ON a.actor_uri = i.actor_uri
WHERE i.actor_uri NOT IN (SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended')
