-- @param {String} $1:accountId
-- @param {String} $2:reblogOfId
SELECT id FROM statuses
WHERE kind = 'LocalReblog' AND account_id = $1 AND reblog_of_id = $2
LIMIT 1
