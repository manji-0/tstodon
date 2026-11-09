-- @param {String} $1:publicKeyPem
-- @param {String} $2:privateKeyJwk
-- @param {String} $3:rotatedAt
-- Replace the instance actor's key pair, or store the first one.
INSERT INTO instance_actor_keys (id, public_key_pem, private_key_jwk, created_at, rotated_at)
VALUES (1, $1, $2, $3, $3)
ON CONFLICT (id) DO UPDATE SET
public_key_pem = excluded.public_key_pem,
private_key_jwk = excluded.private_key_jwk,
rotated_at = excluded.rotated_at
