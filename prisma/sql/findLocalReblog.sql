-- @param {String} $1:accountId
-- @param {String} $2:localStatusId?
-- @param {String} $3:remoteStatusId?
SELECT id FROM statuses
WHERE kind = 'LocalReblog' AND account_id = $1
  AND (reblog_of_id = $2 OR reblog_of_remote_id = $3)
LIMIT 1
