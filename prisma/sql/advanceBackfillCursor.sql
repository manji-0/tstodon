-- @param {String} $1:name
-- @param {String} $2:fromAfterId
-- @param {String} $3:toAfterId
-- @param {String} $4:completedAt?
-- Moves the cursor only from where this page started, so of two runs that
-- read the same page one advances it and the other stops.
UPDATE backfill_cursors SET after_id = $3, completed_at = $4
WHERE name = $1 AND after_id = $2 AND completed_at IS NULL
RETURNING name
