-- @param {String} $1:actorUri
-- @param {String} $2:keysJson
-- Store the keys in $2 (a JSON array of `{ keyId, type, publicKeyPem }`) as
-- `actorUri`'s, as Mastodon's `upsert_all(..., unique_by: :uri)`: a key id
-- another actor holds moves to `actorUri`. The caller passes only keys the
-- actor's host vouches for (`resolvePublishedKeys`).
INSERT INTO remote_actor_keys (key_id, actor_uri, type, public_key_pem)
SELECT json_extract(value, '$.keyId'), $1, json_extract(value, '$.type'), json_extract(value, '$.publicKeyPem')
FROM json_each($2) WHERE true
ON CONFLICT(key_id) DO UPDATE SET
  actor_uri = excluded.actor_uri,
  type = excluded.type,
  public_key_pem = excluded.public_key_pem
