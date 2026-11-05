-- @param {String} $1:usernameLike
-- @param {String} $2:displayNameLike
-- @param {String} $3:followerAccountId
-- @param {Int} $4:limit
-- @param {Int} $5:offset
-- searchAccounts, kept to the accounts $3 follows (`following=true`).
SELECT id, username, access_email, display_name, locked, default_post_visibility, default_quote_policy, public_key_pem, private_key_jwk, created_at, COALESCE(bio_text, '') AS bio_text
FROM accounts
WHERE (username LIKE $1 OR display_name LIKE $2)
  AND id NOT IN (SELECT account_id FROM account_flags WHERE pending <> 0)
  AND id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')
  AND id IN (SELECT target_account_id FROM follows WHERE follower_account_id = $3 AND kind = 'Accepted')
ORDER BY username
LIMIT $4 OFFSET $5
