-- @param {String} $1:accountId
-- @param {String} $2:statusId
-- @param {String} $3:createdAt
INSERT OR IGNORE INTO bookmarks (account_id, status_id, created_at) VALUES ($1, $2, $3)
