-- @param {String} $1:id
SELECT id, ip, severity, comment, created_at, expires_at FROM ip_blocks WHERE id = $1 LIMIT 1
