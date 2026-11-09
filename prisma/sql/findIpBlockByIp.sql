-- @param {String} $1:ip
SELECT id, ip, severity, comment, created_at, expires_at FROM ip_blocks WHERE ip = $1 LIMIT 1
