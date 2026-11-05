-- @param {String} $1:name
SELECT after_id, completed_at FROM backfill_cursors WHERE name = $1
