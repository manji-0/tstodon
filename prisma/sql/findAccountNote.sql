-- @param {String} $1:accountId
-- @param {String} $2:target
-- One equality branch per target column, so each uses an index instead of an
-- OR that reads every note of the account.
SELECT note FROM account_notes
WHERE account_id = $1 AND target_actor_uri = $2
UNION ALL
SELECT note FROM account_notes
WHERE account_id = $1 AND target_account_id = $2
LIMIT 1
