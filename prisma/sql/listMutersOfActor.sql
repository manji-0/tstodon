-- @param {String} $1:targetActorUri
-- @param {String} $2:afterAccountId
-- @param {Int} $3:limit
SELECT account_id, notifications, expires_at FROM mutes
WHERE target_actor_uri = $1 AND account_id > $2 ORDER BY account_id LIMIT $3
