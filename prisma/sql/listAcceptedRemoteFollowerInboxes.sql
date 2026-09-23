-- @param {String} $1:targetAccountId
SELECT a.inbox_uri, a.shared_inbox_uri
FROM remote_follows f
JOIN remote_actors a ON a.actor_uri = f.remote_actor_uri
WHERE f.target_account_id = $1 AND f.follow_kind = 'Accepted'
