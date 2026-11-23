-- @param {String} $1:at
-- @param {String} $2:pollId
-- @param {String} $3:unlessAt
-- Record that the end of a local poll is queued for `at`, unless it already is.
UPDATE polls SET end_queued_at = $1
WHERE id = $2 AND end_queued_at IS NOT $3
RETURNING id
