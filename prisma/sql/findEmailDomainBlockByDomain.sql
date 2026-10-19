-- @param {String} $1:domain
SELECT id, domain, created_at FROM email_domain_blocks WHERE domain = $1 LIMIT 1
