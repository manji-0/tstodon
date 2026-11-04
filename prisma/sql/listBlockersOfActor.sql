-- @param {String} $1:targetActorUri
-- @param {String} $2:afterAccountId
-- @param {Int} $3:limit
SELECT blocker_account_id AS account_id FROM blocks
WHERE target_actor_uri = $1 AND blocker_account_id > $2 ORDER BY blocker_account_id LIMIT $3
