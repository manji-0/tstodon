-- @param {String} $1:term
-- @param {Int} $2:limit
-- @param {Int} $3:offset
-- The rows account search may list, so OFFSET counts listed accounts: not
-- pending approval, and not suspended (`searchableLocalAccounts`).
SELECT id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy, public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text
FROM accounts
WHERE (instr(lower(username), lower($1)) > 0 OR instr(lower(display_name), lower($1)) > 0)
  AND id NOT IN (SELECT account_id FROM account_flags WHERE pending <> 0)
  AND id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')
ORDER BY username
LIMIT $2 OFFSET $3
