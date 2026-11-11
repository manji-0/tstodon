-- @param {String} $1:actorAccountId
-- @param {String} $2:targetsJson
-- Each target is a local account id or an actor URI, matched as `findBlock` matches one.
SELECT target_account_id, target_actor_uri FROM blocks
WHERE blocker_account_id = $1
  AND (target_account_id IN (SELECT value FROM json_each($2))
    OR target_actor_uri IN (SELECT value FROM json_each($2)))
