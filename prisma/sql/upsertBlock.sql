-- @param {String} $1:blockerAccountId
-- @param {String} $2:targetAccountId?
-- @param {String} $3:targetActorUri
-- @param {String} $4:createdAt
INSERT INTO blocks (blocker_account_id, target_account_id, target_actor_uri, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT(blocker_account_id, target_actor_uri) DO UPDATE SET
  target_account_id = excluded.target_account_id
