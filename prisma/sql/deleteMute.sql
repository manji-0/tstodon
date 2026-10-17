-- @param {String} $1:accountId
-- @param {String} $2:targetActorUri
DELETE FROM mutes WHERE account_id = $1 AND target_actor_uri = $2
RETURNING target_actor_uri
