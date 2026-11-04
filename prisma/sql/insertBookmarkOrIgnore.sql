-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:localStatusId?
-- @param {String} $4:remoteStatusId?
-- @param {String} $5:createdAt
INSERT OR IGNORE INTO bookmarks (id, account_id, local_status_id, remote_status_id, created_at)
VALUES ($1, $2, $3, $4, $5)
