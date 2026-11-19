-- @param {String} $1:actorUri
-- @param {String} $2:keysJson
-- Store the keys in $2 (a JSON array of `{ keyId, type, publicKeyPem }`) as
-- `actorUri`'s. A key id another actor holds stays that actor's: one actor's
-- document cannot take a key from another (Mastodon's `upsert_all` moves it,
-- but its key ids are checked against their own URL first).
INSERT INTO remote_actor_keys (key_id, actor_uri, type, public_key_pem)
SELECT json_extract(value, '$.keyId'), $1, json_extract(value, '$.type'), json_extract(value, '$.publicKeyPem')
FROM json_each($2) WHERE true
ON CONFLICT(key_id) DO UPDATE SET
  type = excluded.type,
  public_key_pem = excluded.public_key_pem
WHERE remote_actor_keys.actor_uri = excluded.actor_uri
