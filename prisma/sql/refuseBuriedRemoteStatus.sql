-- @param {String} $1:objectUri
-- Fails the batch it runs in when the author deleted the status `objectUri`
-- (remote_status_tombstones, Mastodon's `tombstone_exists?`): the row it then
-- selects has no actor_uri, which the NOT NULL constraint refuses. It writes
-- nothing otherwise. Run in the batch that stores the status, so a `Delete`
-- handled at the same time either finds the status to remove or buries it
-- before it is stored.
INSERT INTO remote_status_tombstones (object_uri, actor_uri, created_at)
SELECT object_uri, NULL, created_at
FROM remote_status_tombstones
WHERE object_uri = $1
