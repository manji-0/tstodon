-- @param {String} $1:id
-- @param {String} $2:objectKey
-- @param {String} $3:strippedAt
-- @param {String} $4:error?
-- Record what `StripStoredMediaMetadata` did with an attachment still at
-- `objectKey`: stripped or found clean (`error` NULL), or passed over (`error`
-- names why).
UPDATE media_attachments
SET metadata_stripped_at = CASE WHEN $4 IS NULL THEN $3 END,
    metadata_strip_error = $4
WHERE id = $1 AND object_key = $2
