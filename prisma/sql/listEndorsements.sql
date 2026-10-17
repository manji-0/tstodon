-- @param {String} $1:accountId
SELECT target_account_id, target_actor_uri FROM endorsements
WHERE account_id = $1
ORDER BY created_at DESC, target_actor_uri ASC
