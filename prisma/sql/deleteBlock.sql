-- @param {String} $1:blockerAccountId
-- @param {String} $2:targetActorUri
DELETE FROM blocks WHERE blocker_account_id = $1 AND target_actor_uri = $2
RETURNING target_actor_uri
