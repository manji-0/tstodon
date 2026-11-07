-- @param {String} $1:statusId
-- @param {String} $2:accountId
-- A silent mention never replaces one the note already addressed them with.
INSERT OR IGNORE INTO remote_status_mentions (status_id, account_id, silent)
VALUES ($1, $2, 1)
