-- @param {String} $1:statusId
SELECT account_id FROM status_mentions WHERE status_id = $1
