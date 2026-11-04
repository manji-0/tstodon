-- @param {String} $1:claimedAt
-- @param {String} $2:statusId
-- @param {String} $3:staleBefore
UPDATE remote_statuses SET context_fetched_at = $1
WHERE id = $2 AND (context_fetched_at IS NULL OR context_fetched_at < $3)
RETURNING id
