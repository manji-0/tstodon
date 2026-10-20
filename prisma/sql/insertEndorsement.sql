-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:targetAccountId?
-- @param {String} $4:targetActorUri
-- @param {String} $5:createdAt
INSERT INTO endorsements (id, account_id, target_account_id, target_actor_uri, created_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT(account_id, target_actor_uri) DO UPDATE SET target_account_id = $3
