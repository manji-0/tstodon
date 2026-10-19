-- @param {String} $1:id
DELETE FROM canonical_email_blocks WHERE id = $1
RETURNING id
