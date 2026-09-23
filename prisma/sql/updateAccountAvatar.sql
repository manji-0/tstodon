-- @param {String} $1:avatarObjectKey
-- @param {String} $2:updatedAt
-- @param {String} $3:accountId
UPDATE accounts SET avatar_object_key = $1, updated_at = $2 WHERE id = $3
