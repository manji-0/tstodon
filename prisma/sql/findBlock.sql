-- @param {String} $1:actorAccountId
-- @param {String} $2:target
SELECT 1 AS present FROM blocks
WHERE blocker_account_id = $1 AND (target_account_id = $2 OR target_actor_uri = $2)
LIMIT 1
