-- @param {String} $1:targetAccountId
-- @param {String} $2:remoteActorUrisJson
SELECT remote_actor_uri, follow_activity_id, remote_request_kind FROM remote_follows
WHERE target_account_id = $1 AND remote_actor_uri IN (SELECT value FROM json_each($2))
