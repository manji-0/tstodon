-- @param {String} $1:syncedJson
-- `syncedJson` lists `[actorUri, fetchedAt]` pairs: each actor is marked
-- only while it holds the version that was listed.
UPDATE remote_actors
SET collections_synced_at = fetched_at
WHERE actor_uri IN (SELECT json_extract(value, '$[0]') FROM json_each($1))
  AND fetched_at = (
    SELECT json_extract(value, '$[1]') FROM json_each($1)
    WHERE json_extract(value, '$[0]') = remote_actors.actor_uri
  )
