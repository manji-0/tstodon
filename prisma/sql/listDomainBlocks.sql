-- @param {Int} $1:limit
-- @param {String} $2:maxId
SELECT id, domain, severity, reject_media, reject_reports, obfuscate, private_comment, public_comment, created_at
FROM domain_blocks
WHERE ($2 = '' OR id < $2)
ORDER BY id DESC
LIMIT $1
