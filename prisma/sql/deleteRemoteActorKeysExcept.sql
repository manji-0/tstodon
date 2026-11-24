-- @param {String} $1:actorUri
-- @param {String} $2:keysJson
-- Drop the keys of `actorUri` its document no longer publishes: those not in
-- $2, a JSON array of `{ keyId, type, publicKeyPem }`.
-- A suspended actor keeps its keys (`suspended_remote_actors`, migration
-- 0179), as Mastodon skips `set_fetchable_key!` for a local suspension.
DELETE FROM remote_actor_keys
WHERE actor_uri = $1
  AND key_id NOT IN (SELECT json_extract(value, '$.keyId') FROM json_each($2))
  AND NOT EXISTS (SELECT 1 FROM suspended_remote_actors s WHERE s.actor_uri = $1)
