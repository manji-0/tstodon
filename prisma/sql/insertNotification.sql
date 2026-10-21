-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:fromAccountId
-- @param {String} $4:fromActorUri?
-- @param {String} $5:kind
-- @param {String} $6:statusId?
-- @param {String} $7:createdAt
INSERT INTO notifications (id, account_id, from_account_id, from_actor_uri, kind, status_id, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
