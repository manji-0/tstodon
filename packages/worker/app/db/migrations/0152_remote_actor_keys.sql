-- void:allow-destructive
-- (Void gate: the UPDATEs without WHERE backfill the new key columns of every actor.)
-- The public keys of remote actors, as Mastodon's `keypairs` (FED-8): each key
-- an actor document publishes (each `publicKey`, each FEP-521a
-- `assertionMethod` Multikey), under its id, so that a signature finds the key
-- its `keyId` names. A refetch of the actor replaces its keys. `type` is
-- Mastodon's (`rsa`, `ed25519`); `public_key_pem` is SPKI PEM.
CREATE TABLE remote_actor_keys (
  key_id TEXT PRIMARY KEY,
  actor_uri TEXT NOT NULL REFERENCES remote_actors (actor_uri) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('rsa', 'ed25519')),
  public_key_pem TEXT NOT NULL
);

CREATE INDEX idx_remote_actor_keys_actor ON remote_actor_keys (actor_uri);

INSERT INTO remote_actor_keys (key_id, actor_uri, type, public_key_pem)
SELECT public_key_id, actor_uri, 'rsa', public_key_pem FROM remote_actors;

-- `remote_actors.public_key_id` and `public_key_pem` are no longer read. A
-- UNIQUE column cannot be dropped without rebuilding the table, so they stay,
-- written as the actor URI and a placeholder RSA key whose private half was
-- thrown away (`LEGACY_PUBLIC_KEY_PEM` in `server/remote-actor-store.ts`). A
-- build from before this migration, run during the deploy or after a
-- rollback, still reads every row: a signature it checks against the
-- placeholder fails, and it fetches the actor again. The first pass moves
-- every value out of the way (no key id starts with `#`), so the second cannot
-- collide with a row it has not reached yet.
UPDATE remote_actors SET public_key_id = '#' || actor_uri;
UPDATE remote_actors SET public_key_id = actor_uri, public_key_pem = '-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlDmOZr4ifqj8GjQ//kop
6SpR+VT6yWUsAJ/rmi4ePhoOsjCQ1aCpeNm7wr2fq1ZeU6rLnfbACKrGL8WTGNmX
7KuVNnIwJqgrvmfRm7MMAVkLt0QLMoqKwWQZGGNitKhRftoeGpRwPhVHOG0xca8E
rh8ASUo1oZTCLa7wSdrwEH4RbRZzQo6FLpJIM+g0VuBsQtYlEZQAKBN5w5UP0WMB
r9AUBKcxPM4rlch+u2nUB8Nxr3VXQeXvkCIB/lwcw6lh0pbueE1WT/6EHXhRIXSp
ymhLcTzfEN/4GR3viA2r6SAt1PkhhnHH/K04XiZvmHwLt6aFzvZqyEUrc/riWwmd
6QIDAQAB
-----END PUBLIC KEY-----
';
