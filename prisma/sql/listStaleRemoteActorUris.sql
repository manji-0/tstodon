-- @param {String} $1:before
-- @param {Int} $2:limit
-- Oldest first by the later of its last confirmation (its fetch, when
-- WebFinger never confirmed it) and its last refresh attempt, read from
-- `idx_remote_actors_refresh_due` without sorting the stale rows.
SELECT actor_uri FROM remote_actors
WHERE max(coalesce(last_webfingered_at, fetched_at), coalesce(refresh_attempted_at, '')) <= $1
ORDER BY max(coalesce(last_webfingered_at, fetched_at), coalesce(refresh_attempted_at, ''))
LIMIT $2
