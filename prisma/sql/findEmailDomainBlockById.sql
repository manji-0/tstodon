-- @param {String} $1:id
SELECT id, domain, created_at FROM email_domain_blocks WHERE id = $1 LIMIT 1
