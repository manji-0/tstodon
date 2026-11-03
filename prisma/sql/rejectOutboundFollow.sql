-- @param {String} $1:actorUri
-- @param {String} $2:followActivityId
-- @param {String} $3:accountId
DELETE FROM outbound_follows
WHERE actor_uri = $1 AND (follow_activity_id = $2 OR account_id = $3)
RETURNING id
