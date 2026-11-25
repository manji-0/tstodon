-- @param {Int} $1:limit
-- The actors that name a `featuredCollections` and were fetched since it
-- was last queued for reading, the longest waiting first.
SELECT actor_uri, fetched_at
FROM remote_actors
WHERE json_extract(profile_json, '$.featuredCollectionsUri') IS NOT NULL
  AND (collections_synced_at IS NULL OR collections_synced_at < fetched_at)
ORDER BY fetched_at
LIMIT $1
