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
-- written as the actor URI and ''. The first pass moves every value out of the
-- way (no key id starts with `#`), so the second cannot collide with a row it
-- has not reached yet.
UPDATE remote_actors SET public_key_id = '#' || actor_uri;
UPDATE remote_actors SET public_key_id = actor_uri, public_key_pem = '';
