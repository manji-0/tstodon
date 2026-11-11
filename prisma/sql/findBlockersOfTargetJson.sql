-- @param {String} $1:blockerIdsJson
-- @param {String} $2:target
SELECT blocker_account_id FROM blocks
WHERE blocker_account_id IN (SELECT value FROM json_each($1))
  AND (target_account_id = $2 OR target_actor_uri = $2)
