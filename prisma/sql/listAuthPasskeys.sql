-- @param {String} $1:userId
SELECT id, name, createdAt, deviceType, backedUp
FROM passkey
WHERE userId = $1
ORDER BY createdAt, id
