-- @param {String} $1:actorUri
-- @param {String} $2:url
-- @param {String} $3:digest
-- @param {String} $4:lockedAt
-- @param {String} $5:staleBefore
-- Take the lock of a synchronization job: a row when it was free, or held
-- since before `staleBefore` (by a job that was lost); none when it is held.
INSERT INTO followers_synchronization_locks (actor_uri, url, digest, locked_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (actor_uri, url, digest) DO UPDATE SET locked_at = excluded.locked_at
WHERE followers_synchronization_locks.locked_at < $5
RETURNING actor_uri
