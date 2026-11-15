-- @param {String} $1:accountId
-- The inboxes of the remote actors the account follows or asked to follow.
SELECT a.inbox_uri, a.shared_inbox_uri
FROM outbound_follows f
JOIN remote_actors a ON a.actor_uri = f.actor_uri
WHERE f.account_id = $1
