-- @param {String} $1:statusId
-- @param {String} $2:accountId
SELECT 1 AS ok FROM status_mentions WHERE status_id = $1 AND account_id = $2
