-- @param {String} $1:targetAccountId
-- @param {String} $2:remoteActorUri
-- @param {String} $3:acceptedAt
UPDATE remote_follows
SET remote_request_kind = 'Fulfilled', follow_kind = 'Accepted', created_at = $3
WHERE target_account_id = $1 AND remote_actor_uri = $2 AND remote_request_kind = 'Queued'
RETURNING remote_actor_uri
