-- @param {String} $1:actorUri
-- @param {String} $2:accountId
SELECT 1 AS present FROM remote_blocks
WHERE actor_uri = $1 AND account_id = $2
LIMIT 1
