-- @param {String} $1:id
-- @param {String} $2:remoteActorUri
-- @param {String} $3:targetAccountId
-- @param {String} $4:remoteRequestKind
-- @param {String} $5:followKind
-- @param {String} $6:followActivityId?
-- @param {String} $7:createdAt
-- @param {String} $8:undoneAfter
-- Record a remote actor's `Follow`, unless its `Undo` was handled first and
-- remembered after `undoneAfter` (`rememberUndoneFollow.sql`). Returns the
-- row only when the follow was recorded.
INSERT INTO remote_follows (
  id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, follow_activity_id, created_at
)
SELECT $1, $2, $3, $4, $5, $6, $7
WHERE NOT EXISTS (
  SELECT 1 FROM undone_before_arrival
  WHERE actor_uri = $2 AND activity_uri = $6 AND created_at > $8
)
ON CONFLICT(remote_actor_uri, target_account_id) DO UPDATE SET
  remote_request_kind = excluded.remote_request_kind,
  follow_kind = excluded.follow_kind,
  follow_activity_id = excluded.follow_activity_id
RETURNING id
