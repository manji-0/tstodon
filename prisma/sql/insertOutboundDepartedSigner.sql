-- @param {String} $1:activityId
-- @param {String} $2:username
-- @param {String} $3:privateKeyJwk
INSERT INTO outbound_departed_signers (activity_id, username, private_key_jwk)
VALUES ($1, $2, $3)
