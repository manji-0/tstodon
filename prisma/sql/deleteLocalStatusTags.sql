-- @param {String} $1:statusId
-- @param {String} $2:accountId
DELETE FROM local_status_tags
WHERE status_id = $1
  AND EXISTS (SELECT 1 FROM statuses s WHERE s.id = $1 AND s.account_id = $2)
