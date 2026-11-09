-- @param {String} $1:id
-- @param {String} $2:objectKey
-- @param {String} $3:strippedAt
-- @param {String} $4:error?
-- @param {Int} $5:fileSize
-- Record what `StripStoredMediaMetadata` did with an attachment still at
-- `objectKey`: stripped or found clean (`error` NULL), or passed over (`error`
-- names why). `fileSize` is the size of the object now at `objectKey`, which
-- a rewrite changes.
UPDATE media_attachments
SET metadata_stripped_at = CASE WHEN $4 IS NULL THEN $3 END,
    metadata_strip_error = $4,
    file_size = $5
WHERE id = $1 AND object_key = $2
