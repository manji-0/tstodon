-- @param {String} $1:targetAccountId
-- @param {String} $2:remoteActorUri
DELETE FROM remote_follows
WHERE target_account_id = $1 AND remote_actor_uri = $2 AND remote_request_kind = 'Queued'
RETURNING remote_actor_uri
