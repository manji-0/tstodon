-- @param {String} $1:tokenHash
SELECT username, email, expires_at FROM signup_intents WHERE token_hash = $1
