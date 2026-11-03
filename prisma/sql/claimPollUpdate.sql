-- @param {String} $1:queuedAt
-- @param {String} $2:pollId
UPDATE polls SET update_queued_at = $1
WHERE id = $2 AND update_queued_at IS NULL
RETURNING id
