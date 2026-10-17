-- @param {String} $1:id
SELECT updated_at FROM statuses WHERE id = $1 LIMIT 1
