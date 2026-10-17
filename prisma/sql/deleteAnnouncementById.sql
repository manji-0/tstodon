-- @param {String} $1:id
DELETE FROM announcements WHERE id = $1
RETURNING id
