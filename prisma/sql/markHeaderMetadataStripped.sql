-- @param {String} $1:accountId
-- @param {String} $2:objectKey
-- @param {String} $3:strippedAt
-- @param {String} $4:error?
-- @param {Int} $5:fileSize
-- As `markMediaMetadataStripped`, for a header still at `objectKey`.
UPDATE account_profiles
SET header_metadata_stripped_at = CASE WHEN $4 IS NULL THEN $3 END,
    header_metadata_strip_error = $4,
    header_file_size = $5
WHERE account_id = $1 AND header_object_key = $2
