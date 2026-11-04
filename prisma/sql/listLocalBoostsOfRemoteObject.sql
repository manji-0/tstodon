-- @param {String} $1:objectUri
-- @param {String} $2:actorUri
SELECT s.id, s.account_id
FROM statuses s
JOIN remote_statuses r ON r.id = s.reblog_of_remote_id
WHERE r.object_uri = $1 AND r.actor_uri = $2 AND s.kind = 'LocalReblog'
