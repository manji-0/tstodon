-- @param {String} $1:statusId
-- @param {String} $2:claimedAt
UPDATE remote_statuses SET thread_resolve_queued_at = NULL
WHERE id = $1 AND thread_resolve_queued_at = $2
