-- @param {String} $1:accountId
-- @param {String} $2:objectKey
-- @param {Int} $3:fileSize
-- As `recordMediaFileSizes`, for a header still at `objectKey`.
UPDATE account_profiles SET header_file_size = $3
WHERE account_id = $1 AND header_object_key = $2 AND header_file_size IS NULL
