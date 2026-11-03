-- @param {String} $1:accountId
-- @param {String} $2:actorUri
DELETE FROM outbound_follows WHERE account_id = $1 AND actor_uri = $2
RETURNING follow_activity_id
