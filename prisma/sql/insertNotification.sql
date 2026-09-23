-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:fromAccountId
-- @param {String} $4:kind
-- @param {String} $5:statusId?
-- @param {String} $6:createdAt
INSERT INTO notifications (id, account_id, from_account_id, kind, status_id, created_at)
VALUES ($1, $2, $3, $4, $5, $6)
