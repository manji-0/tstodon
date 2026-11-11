-- @param {String} $1:id
-- @param {String} $2:username
-- The account with id $1, else the one with username $2.
SELECT id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy, public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text
FROM accounts WHERE id = $1 OR username = $2
ORDER BY id = $1 DESC
LIMIT 1
