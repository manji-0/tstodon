-- @param {String} $1:targetAccountId
-- @param {String} $2:actorUrisJson
SELECT remote_actor_uri FROM remote_follows
WHERE target_account_id = $1 AND follow_kind = 'Accepted'
  AND remote_actor_uri IN (SELECT value FROM json_each($2))
