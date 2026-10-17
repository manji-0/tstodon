-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:title
-- @param {String} $4:repliesPolicy
-- @param {Int} $5:exclusive
-- @param {String} $6:createdAt
-- @param {String} $7:updatedAt
INSERT INTO account_lists (id, account_id, title, replies_policy, exclusive, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
