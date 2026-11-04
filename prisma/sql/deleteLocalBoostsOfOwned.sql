-- @param {String} $1:statusId
-- @param {String} $2:accountId
DELETE FROM statuses
WHERE kind = 'LocalReblog' AND reblog_of_id = $1
  AND EXISTS (SELECT 1 FROM statuses WHERE id = $1 AND account_id = $2)
RETURNING id, account_id
