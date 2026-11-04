-- @param {String} $1:userId
-- @param {Int} $2:now
SELECT id, createdAt, expiresAt, ipAddress, userAgent
FROM "session"
WHERE userId = $1 AND expiresAt > $2
ORDER BY createdAt DESC, id
