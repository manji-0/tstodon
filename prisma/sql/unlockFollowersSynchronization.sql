-- @param {String} $1:actorUri
-- @param {String} $2:url
-- @param {String} $3:digest
-- @param {String} $4:staleBefore
-- Free the lock of a job that ran, and any lock left by a job that was lost.
DELETE FROM followers_synchronization_locks
WHERE (actor_uri = $1 AND url = $2 AND digest = $3) OR locked_at < $4
