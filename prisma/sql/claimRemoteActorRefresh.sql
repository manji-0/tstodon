-- @param {String} $1:actorUri
-- @param {String} $2:before
-- @param {String} $3:now
-- Mark the actor tried now when it is due (as `listStaleRemoteActorUris`
-- reads due), so a cron run and a handle lookup that both find it due
-- refresh it once, and an actor whose servers do not answer is tried again
-- only a day later. Returns the row when this claim took it.
UPDATE remote_actors SET refresh_attempted_at = $3
WHERE actor_uri = $1
  AND max(coalesce(last_webfingered_at, fetched_at), coalesce(refresh_attempted_at, '')) <= $2
RETURNING actor_uri
