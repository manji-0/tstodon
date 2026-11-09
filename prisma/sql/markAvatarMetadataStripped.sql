-- @param {String} $1:accountId
-- @param {String} $2:objectKey
-- @param {String} $3:strippedAt
-- @param {String} $4:error?
-- As `markMediaMetadataStripped`, for an avatar still at `objectKey`.
UPDATE account_profiles
SET avatar_metadata_stripped_at = CASE WHEN $4 IS NULL THEN $3 END,
    avatar_metadata_strip_error = $4
WHERE account_id = $1 AND avatar_object_key = $2
