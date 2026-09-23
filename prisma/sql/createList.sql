-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:title
-- @param {String} $4:repliesPolicy
-- @param {String} $5:createdAt
-- @param {String} $6:updatedAt
INSERT INTO account_lists (id, account_id, title, replies_policy, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6)
