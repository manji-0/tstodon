-- @param {String} $1:tokenHash
-- @param {String} $2:username
-- @param {String} $3:email
-- @param {String} $4:expiresAt
-- @param {String} $5:createdAt
INSERT INTO signup_intents (token_hash, username, email, expires_at, created_at)
VALUES ($1, $2, $3, $4, $5)
