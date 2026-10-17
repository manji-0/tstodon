-- @param {String} $1:accountId
-- @param {String} $2:targetAccountId?
-- @param {String} $3:targetActorUri
-- @param {String} $4:note
-- @param {String} $5:now
INSERT INTO account_notes (account_id, target_account_id, target_actor_uri, note, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $5)
ON CONFLICT(account_id, target_actor_uri)
DO UPDATE SET target_account_id = $2, note = $4, updated_at = $5
