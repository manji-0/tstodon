-- @param {String} $1:name
SELECT after_id FROM backfill_cursors WHERE name = $1
