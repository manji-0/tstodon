-- @param {String} $1:accountId
-- @param {String} $2:targetAccountId?
-- @param {String} $3:targetActorUri
-- @param {String} $4:createdAt
INSERT INTO endorsements (account_id, target_account_id, target_actor_uri, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT(account_id, target_actor_uri) DO UPDATE SET target_account_id = $2
