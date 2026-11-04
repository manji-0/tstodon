-- @param {String} $1:id
-- @param {String} $2:userId
-- @param {String} $3:name
UPDATE passkey SET name = $3 WHERE id = $1 AND userId = $2
