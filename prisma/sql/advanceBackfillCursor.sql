-- @param {String} $1:name
-- @param {String} $2:fromAfterId
-- @param {String} $3:toAfterId
-- Moves the cursor only from where this page started, so of two runs that
-- read the same page one advances it and the other stops.
UPDATE backfill_cursors SET after_id = $3
WHERE name = $1 AND after_id = $2
RETURNING name
