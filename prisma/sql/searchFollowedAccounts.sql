-- @param {String} $1:term
-- @param {String} $2:followerAccountId
-- @param {Int} $3:limit
-- @param {Int} $4:offset
-- searchAccounts, kept to the accounts $2 follows (`following=true`).
SELECT id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy, public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text
FROM accounts
WHERE (instr(lower(username), lower($1)) > 0 OR instr(lower(display_name), lower($1)) > 0)
  AND id NOT IN (SELECT account_id FROM account_flags WHERE pending <> 0)
  AND id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')
  AND id IN (SELECT target_account_id FROM follows WHERE follower_account_id = $2 AND kind = 'Accepted')
ORDER BY username
LIMIT $3 OFFSET $4
