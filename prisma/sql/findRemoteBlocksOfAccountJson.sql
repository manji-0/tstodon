-- @param {String} $1:actorUrisJson
-- @param {String} $2:accountId
SELECT actor_uri FROM remote_blocks
WHERE actor_uri IN (SELECT value FROM json_each($1)) AND account_id = $2
