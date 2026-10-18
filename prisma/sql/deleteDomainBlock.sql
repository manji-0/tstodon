-- @param {String} $1:id
DELETE FROM domain_blocks WHERE id = $1
RETURNING id
