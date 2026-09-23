-- @param {String} $1:statusId
-- @param {String} $2:accountId
INSERT OR IGNORE INTO status_mentions (status_id, account_id) VALUES ($1, $2)
