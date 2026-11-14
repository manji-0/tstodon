-- @param {String} $1:term
-- The number of rows searchAccounts lists.
SELECT COUNT(*) AS count
FROM accounts
WHERE (instr(lower(username), lower($1)) > 0 OR instr(lower(display_name), lower($1)) > 0)
  AND id NOT IN (SELECT account_id FROM account_flags WHERE pending <> 0)
  AND id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')
