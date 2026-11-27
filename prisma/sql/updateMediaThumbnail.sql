-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:previewObjectKey?
-- @param {Int} $4:previewWidth?
-- @param {Int} $5:previewHeight?
-- @param {Int} $6:previewFileSize?
-- @param {String} $7:blurhash?
-- @param {String} $8:thumbnailContentType?
-- Set or clear the custom thumbnail of an attachment no status holds.
UPDATE media_attachments
SET preview_object_key = $3, preview_width = $4, preview_height = $5, preview_file_size = $6,
  blurhash = $7, thumbnail_content_type = $8
WHERE id = $1 AND account_id = $2 AND status_id IS NULL
RETURNING id
