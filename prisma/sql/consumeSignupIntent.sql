-- @param {String} $1:tokenHash
DELETE FROM signup_intents WHERE token_hash = $1
RETURNING username, email, expires_at
