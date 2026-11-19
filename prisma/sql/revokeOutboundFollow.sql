-- @param {String} $1:actorUri
-- @param {String} $2:followActivityId
-- The actor takes back its `Accept` of the `Follow`: the follow is a request
-- again, as Mastodon's `Follow#revoke_request!`.
UPDATE outbound_follows SET state = 'Requested'
WHERE actor_uri = $1 AND follow_activity_id = $2 AND state = 'Accepted'
