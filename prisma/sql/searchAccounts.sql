-- @param {String} $1:usernameLike
-- @param {String} $2:displayNameLike
-- @param {Int} $3:limit
SELECT id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy, public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text, avatar_object_key, header_object_key
FROM accounts
WHERE username LIKE $1 OR display_name LIKE $2
ORDER BY username
LIMIT $3
