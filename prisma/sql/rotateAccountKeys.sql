-- @param {String} $1:accountId
-- @param {String} $2:publicKeyPem
-- @param {String} $3:privateKeyJwk
-- @param {String} $4:rotatedAt
-- Replace a local account's key pair; returns the row when the account exists.
UPDATE accounts SET public_key_pem = $2, private_key_jwk = $3, key_rotated_at = $4
WHERE id = $1
RETURNING id
