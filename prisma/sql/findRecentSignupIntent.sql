-- @param {String} $1:email
-- @param {String} $2:since
SELECT created_at FROM signup_intents WHERE email = $1 AND created_at > $2 LIMIT 1
