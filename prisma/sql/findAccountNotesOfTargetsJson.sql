-- @param {String} $1:accountId
-- @param {String} $2:targetsJson
SELECT target_account_id, target_actor_uri, note FROM account_notes
WHERE account_id = $1
  AND (target_account_id IN (SELECT value FROM json_each($2))
    OR target_actor_uri IN (SELECT value FROM json_each($2)))
