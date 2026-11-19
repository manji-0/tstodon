-- @param {String} $1:id
-- @param {String} $2:remoteActorUri
-- @param {String} $3:statusId
-- @param {String} $4:createdAt
-- @param {String} $5:activityId
-- @param {String} $6:undoneAfter
-- A `Like` whose `Undo` was handled first (`rememberUndone.sql`) is dropped.
INSERT INTO remote_favourites (id, remote_actor_uri, status_id, created_at)
SELECT $1, $2, $3, $4
WHERE NOT EXISTS (
  SELECT 1 FROM undone_before_arrival
  WHERE actor_uri = $2 AND activity_uri = $5 AND created_at > $6
)
ON CONFLICT(remote_actor_uri, status_id) DO NOTHING
RETURNING id
