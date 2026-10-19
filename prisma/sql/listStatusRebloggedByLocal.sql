-- @param {String} $1:statusId
-- @param {Int} $2:limit
SELECT account_id, created_at FROM statuses
WHERE kind = 'LocalReblog' AND reblog_of_id = $1
ORDER BY created_at DESC, account_id DESC
LIMIT $2
