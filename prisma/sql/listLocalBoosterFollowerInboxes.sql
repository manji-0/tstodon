-- @param {String} $1:localStatusId?
-- @param {String} $2:remoteStatusId?
-- The inboxes of the accepted remote followers of the local accounts that
-- boost the status (a local one by `$1`, a remote one by `$2`).
SELECT DISTINCT a.inbox_uri, a.shared_inbox_uri
FROM statuses b
JOIN remote_follows f ON f.target_account_id = b.account_id AND f.follow_kind = 'Accepted'
JOIN remote_actors a ON a.actor_uri = f.remote_actor_uri
WHERE b.kind = 'LocalReblog' AND (b.reblog_of_id = $1 OR b.reblog_of_remote_id = $2)
