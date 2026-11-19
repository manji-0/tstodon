-- @param {String} $1:actorUri
-- @param {String} $2:keysJson
-- Drop the keys of `actorUri` its document no longer publishes: those not in
-- $2, a JSON array of `{ keyId, type, publicKeyPem }`.
DELETE FROM remote_actor_keys
WHERE actor_uri = $1
  AND key_id NOT IN (SELECT json_extract(value, '$.keyId') FROM json_each($2))
