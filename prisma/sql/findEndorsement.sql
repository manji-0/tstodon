-- @param {String} $1:accountId
-- @param {String} $2:target
SELECT 1 AS present FROM endorsements
WHERE account_id = $1 AND (target_account_id = $2 OR target_actor_uri = $2)
LIMIT 1
