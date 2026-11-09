-- @param {String} $1:id
-- @param {String} $2:ip
-- @param {String} $3:severity
-- @param {String} $4:comment
-- @param {String} $5:createdAt
-- @param {String} $6:expiresAt
INSERT INTO ip_blocks (id, ip, severity, comment, created_at, updated_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $5, NULLIF($6, ''))
