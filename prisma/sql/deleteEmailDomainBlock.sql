-- @param {String} $1:id
DELETE FROM email_domain_blocks WHERE id = $1
RETURNING id
