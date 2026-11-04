-- @param {String} $1:actorUri
SELECT s.id, s.account_id
FROM statuses s
JOIN remote_statuses r ON r.id = s.reblog_of_remote_id
WHERE r.actor_uri = $1 AND s.kind = 'LocalReblog'
