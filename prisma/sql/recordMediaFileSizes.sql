-- @param {String} $1:id
-- @param {String} $2:objectKey?
-- @param {Int} $3:fileSize?
-- @param {String} $4:previewObjectKey?
-- @param {Int} $5:previewFileSize?
-- Record the sizes `BackfillStoredMediaSizes` read for an attachment's
-- original and preview, each only while the row still holds that key and the
-- size is not known: an upload or a metadata rewrite since knows better.
UPDATE media_attachments
SET file_size = CASE
      WHEN file_size IS NULL AND object_key = $2 THEN $3 ELSE file_size END,
    preview_file_size = CASE
      WHEN preview_file_size IS NULL AND preview_object_key = $4 THEN $5
      ELSE preview_file_size END
WHERE id = $1
