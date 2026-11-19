-- @param {String} $1:actorUri
-- @param {String} $2:followActivityId
-- @param {String} $3:targetAccountId
-- @param {String} $4:createdAt
-- Remember an `Undo(Follow)` that found no follow of the target to end, so
-- its `Follow` is dropped when it comes (`upsertRemoteFollow.sql`). Run in one
-- batch with the delete of the follow: a `Follow` recorded first is ended by
-- the delete, one recorded after finds this row.
INSERT INTO undone_before_arrival (actor_uri, activity_uri, created_at)
SELECT $1, $2, $4
WHERE NOT EXISTS (
  SELECT 1 FROM remote_follows WHERE remote_actor_uri = $1 AND target_account_id = $3
)
ON CONFLICT (actor_uri, activity_uri) DO UPDATE SET created_at = excluded.created_at
