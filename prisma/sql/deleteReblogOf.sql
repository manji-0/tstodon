-- @param {String} $1:accountId
-- @param {String} $2:reblogOfId
DELETE FROM statuses WHERE account_id = $1 AND kind = 'LocalReblog' AND reblog_of_id = $2
