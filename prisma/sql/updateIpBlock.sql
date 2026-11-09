-- @param {String} $1:id
-- @param {String} $2:ip
-- @param {String} $3:severity
-- @param {String} $4:comment
-- @param {String} $5:expiresAt
-- @param {String} $6:updatedAt
UPDATE ip_blocks
SET ip = $2, severity = $3, comment = $4, expires_at = NULLIF($5, ''), updated_at = $6
WHERE id = $1
