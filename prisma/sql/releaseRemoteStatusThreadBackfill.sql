-- @param {String} $1:statusId
-- @param {String} $2:claimedAt
UPDATE remote_statuses SET context_fetched_at = NULL
WHERE id = $1 AND context_fetched_at = $2
