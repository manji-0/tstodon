-- @param {String} $1:sessionId
-- @param {String} $2:userId
DELETE FROM "session" WHERE id = $1 AND userId = $2
