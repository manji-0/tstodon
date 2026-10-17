-- @param {String} $1:blockerAccountId
-- @param {Int} $2:limit
SELECT target_account_id, target_actor_uri, created_at FROM blocks
WHERE blocker_account_id = $1 AND target_account_id IS NOT NULL
ORDER BY created_at DESC LIMIT $2
