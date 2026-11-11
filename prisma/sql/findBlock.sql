-- @param {String} $1:actorAccountId
-- @param {String} $2:target
-- One equality branch per target column, so each uses an index instead of an
-- OR that reads every block of the blocker.
SELECT 1 AS present FROM blocks
WHERE blocker_account_id = $1 AND target_actor_uri = $2
UNION ALL
SELECT 1 AS present FROM blocks
WHERE blocker_account_id = $1 AND target_account_id = $2
LIMIT 1
