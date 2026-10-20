-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:statusId
-- @param {String} $4:createdAt
INSERT OR IGNORE INTO favourites (id, account_id, status_id, created_at) VALUES ($1, $2, $3, $4)
RETURNING account_id
