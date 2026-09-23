-- @param {String} $1:id
-- @param {String} $2:followerId
-- @param {String} $3:targetId
-- @param {String} $4:kind
-- @param {String} $5:createdAt
INSERT OR IGNORE INTO follows (id, follower_account_id, target_account_id, kind, created_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING id
