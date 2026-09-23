-- @param {String} $1:displayName
-- @param {String} $2:updatedAt
-- @param {String} $3:accountId
UPDATE accounts SET display_name = $1, updated_at = $2 WHERE id = $3
