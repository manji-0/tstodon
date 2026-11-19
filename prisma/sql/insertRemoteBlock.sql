-- @param {String} $1:actorUri
-- @param {String} $2:accountId
-- @param {String} $3:activityUri
-- @param {String} $4:createdAt
-- @param {String} $5:undoneAfter
-- A `Block` whose `Undo` was handled first (`rememberUndone.sql`) is dropped.
-- A block already held takes the new `Block`'s id, as Mastodon's.
INSERT INTO remote_blocks (actor_uri, account_id, activity_uri, created_at)
SELECT $1, $2, $3, $4
WHERE NOT EXISTS (
  SELECT 1 FROM undone_before_arrival
  WHERE actor_uri = $1 AND activity_uri = $3 AND created_at > $5
)
ON CONFLICT (actor_uri, account_id) DO UPDATE SET activity_uri = excluded.activity_uri
