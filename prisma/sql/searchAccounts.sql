-- @param {String} $1:usernameLike
-- @param {String} $2:displayNameLike
-- @param {Int} $3:limit
-- @param {Int} $4:offset
-- The rows account search may list, so OFFSET counts listed accounts: not
-- pending approval, and not suspended (`searchableLocalAccounts`).
SELECT id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy, public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text
FROM accounts
WHERE (username LIKE $1 OR display_name LIKE $2)
  AND id NOT IN (SELECT account_id FROM account_flags WHERE pending <> 0)
  AND id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')
ORDER BY username
LIMIT $3 OFFSET $4
