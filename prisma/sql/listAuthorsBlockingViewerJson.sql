-- @param {String} $1:viewerId
-- @param {String} $2:accountIdsJson
-- @param {String} $3:actorUrisJson
-- Which of the local accounts $2 and remote actors $3 block the viewer: `author` is an account id or an actor URI.
SELECT blocker_account_id AS author FROM blocks
WHERE target_account_id = $1
  AND blocker_account_id IN (SELECT value FROM json_each($2))
UNION ALL
SELECT actor_uri AS author FROM remote_blocks
WHERE account_id = $1
  AND actor_uri IN (SELECT value FROM json_each($3))
