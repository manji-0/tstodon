-- @param {String} $1:headerObjectKey
-- @param {String} $2:updatedAt
-- @param {String} $3:accountId
UPDATE accounts SET header_object_key = $1, updated_at = $2 WHERE id = $3
