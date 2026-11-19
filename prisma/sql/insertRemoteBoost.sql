-- @param {String} $1:id
-- @param {String} $2:actorUri
-- @param {String} $3:activityId
-- @param {String} $4:localStatusId?
-- @param {String} $5:remoteStatusId?
-- @param {String} $6:visibility
-- @param {String} $7:publishedAt
-- @param {String} $8:createdAt
-- @param {String} $9:undoneAfter
-- An `Announce` whose `Undo` was handled first (`rememberUndone.sql`) is dropped.
INSERT INTO remote_boosts (
  id, actor_uri, activity_id, local_status_id, remote_status_id, visibility, published_at, created_at
)
SELECT $1, $2, $3, $4, $5, $6, $7, $8
WHERE NOT EXISTS (
  SELECT 1 FROM undone_before_arrival
  WHERE actor_uri = $2 AND activity_uri = $3 AND created_at > $9
)
ON CONFLICT DO NOTHING
RETURNING id
