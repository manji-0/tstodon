-- @param {String} $1:id
-- @param {String} $2:remoteActorUri
-- @param {String} $3:statusId
-- @param {String} $4:activityId
-- @param {String} $5:createdAt
-- @param {String} $6:undoneAfter
-- An `Announce` whose `Undo` was handled first (`rememberUndone.sql`) is dropped.
INSERT INTO remote_announces (id, remote_actor_uri, status_id, activity_id, created_at)
SELECT $1, $2, $3, $4, $5
WHERE NOT EXISTS (
  SELECT 1 FROM undone_before_arrival
  WHERE actor_uri = $2 AND activity_uri = $4 AND created_at > $6
)
ON CONFLICT(remote_actor_uri, status_id) DO UPDATE SET
  activity_id = excluded.activity_id
RETURNING id, created_at
