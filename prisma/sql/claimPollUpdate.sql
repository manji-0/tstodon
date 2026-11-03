-- @param {String} $1:queuedAt
-- @param {String} $2:pollId
-- @param {String} $3:staleBefore
UPDATE polls SET update_queued_at = $1
WHERE id = $2 AND (update_queued_at IS NULL OR update_queued_at < $3)
RETURNING id
