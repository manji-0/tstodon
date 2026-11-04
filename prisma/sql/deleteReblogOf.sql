-- @param {String} $1:accountId
-- @param {String} $2:localStatusId?
-- @param {String} $3:remoteStatusId?
DELETE FROM statuses
WHERE account_id = $1 AND kind = 'LocalReblog'
  AND (reblog_of_id = $2 OR reblog_of_remote_id = $3)
