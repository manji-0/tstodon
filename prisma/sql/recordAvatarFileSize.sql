-- @param {String} $1:accountId
-- @param {String} $2:objectKey
-- @param {Int} $3:fileSize
-- As `recordMediaFileSizes`, for an avatar still at `objectKey`.
UPDATE account_profiles SET avatar_file_size = $3
WHERE account_id = $1 AND avatar_object_key = $2 AND avatar_file_size IS NULL
