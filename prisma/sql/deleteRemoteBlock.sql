-- @param {String} $1:actorUri
-- @param {String} $2:accountId
DELETE FROM remote_blocks WHERE actor_uri = $1 AND account_id = $2
