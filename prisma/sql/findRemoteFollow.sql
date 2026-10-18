-- @param {String} $1:targetAccountId
-- @param {String} $2:remoteActorUri
SELECT follow_activity_id, remote_request_kind FROM remote_follows
WHERE target_account_id = $1 AND remote_actor_uri = $2
LIMIT 1
