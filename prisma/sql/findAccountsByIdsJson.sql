-- @param {String} $1:idsJson
SELECT id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy, public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text, avatar_object_key, header_object_key
FROM accounts WHERE id IN (SELECT value FROM json_each($1))
