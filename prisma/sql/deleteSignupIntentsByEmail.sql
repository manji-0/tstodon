-- @param {String} $1:email
-- @param {String} $2:now
DELETE FROM signup_intents WHERE email = $1 OR expires_at <= $2
