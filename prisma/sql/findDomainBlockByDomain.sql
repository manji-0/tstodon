-- @param {String} $1:domain
SELECT id, domain, severity, reject_media, reject_reports, obfuscate, private_comment, public_comment, created_at
FROM domain_blocks WHERE domain = $1 LIMIT 1
