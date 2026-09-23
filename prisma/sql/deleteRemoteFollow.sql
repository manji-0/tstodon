-- @param {String} $1:remoteActorUri
-- @param {String} $2:targetAccountId
DELETE FROM remote_follows WHERE remote_actor_uri = $1 AND target_account_id = $2
