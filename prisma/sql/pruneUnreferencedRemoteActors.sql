-- @param {String} $1:actorUrisJson
-- @param {String} $2:cachedBefore
-- Delete the actors of `$1` (the authors in one retention slice) cached
-- before $2 that nothing refers to any more: no status of theirs is left,
-- no local account follows, blocks, mutes, endorses, notes or reported them,
-- they follow, favourited, boosted or blocked no local account or status,
-- no local status mentions them, no notification comes from them, and an
-- admin has not moderated them. Each NOT EXISTS is one indexed equality;
-- deleting cascades only to rows these probes found empty.
DELETE FROM remote_actors AS a
WHERE a.actor_uri IN (SELECT value FROM json_each($1))
  AND a.created_at < $2
  AND NOT EXISTS (SELECT 1 FROM remote_statuses s WHERE s.actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM outbound_follows f WHERE f.actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM remote_follows f WHERE f.remote_actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM remote_favourites f WHERE f.remote_actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM remote_announces r WHERE r.remote_actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM remote_boosts b WHERE b.actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM status_remote_mentions m WHERE m.actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.from_actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.target_actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM mutes m WHERE m.target_actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM endorsements e WHERE e.target_actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM account_notes n WHERE n.target_actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM remote_blocks b WHERE b.actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM remote_actor_moderation m WHERE m.actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.target_actor_uri = a.actor_uri)
  AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.reporter_actor_uri = a.actor_uri)
RETURNING actor_uri
