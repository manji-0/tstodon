-- @param {String} $1:publicKeyPem
-- @param {String} $2:privateKeyJwk
-- @param {String} $3:createdAt
-- The first key pair stored wins; a concurrent first use keeps it.
INSERT INTO instance_actor_keys (id, public_key_pem, private_key_jwk, created_at)
VALUES (1, $1, $2, $3)
ON CONFLICT (id) DO NOTHING
