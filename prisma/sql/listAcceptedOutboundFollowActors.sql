-- @param {String} $1:accountId
-- @param {String} $2:actorUrisJson
SELECT actor_uri FROM outbound_follows
WHERE account_id = $1 AND state = 'Accepted' AND actor_uri IN (SELECT value FROM json_each($2))
