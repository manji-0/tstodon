-- @param {String} $1:usernameLike
-- @param {String} $2:displayNameLike
-- The number of rows searchAccounts lists.
SELECT COUNT(*) AS count
FROM accounts
WHERE (username LIKE $1 OR display_name LIKE $2)
  AND id NOT IN (SELECT account_id FROM account_flags WHERE pending <> 0)
  AND id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')
