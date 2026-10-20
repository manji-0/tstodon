-- @param {String} $1:id
-- @param {String} $2:blockerAccountId
-- @param {String} $3:targetAccountId?
-- @param {String} $4:targetActorUri
-- @param {String} $5:createdAt
INSERT INTO blocks (id, blocker_account_id, target_account_id, target_actor_uri, created_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT(blocker_account_id, target_actor_uri) DO UPDATE SET
  target_account_id = excluded.target_account_id
