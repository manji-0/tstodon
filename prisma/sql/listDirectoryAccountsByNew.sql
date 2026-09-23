-- @param {Int} $1:limit
-- @param {Int} $2:offset
SELECT id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy, public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text
FROM accounts
ORDER BY accounts.created_at DESC
LIMIT $1 OFFSET $2
