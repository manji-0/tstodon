-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:objectKey
-- @param {String} $4:contentType
-- @param {String} $5:createdAt
-- @param {String} $6:description?
-- @param {Float} $7:focusX?
-- @param {Float} $8:focusY?
-- @param {Int} $9:width?
-- @param {Int} $10:height?
-- @param {String} $11:previewObjectKey?
-- @param {Int} $12:previewWidth?
-- @param {Int} $13:previewHeight?
-- @param {String} $14:blurhash?
INSERT INTO media_attachments (
  id, account_id, object_key, content_type, created_at, description, focus_x, focus_y,
  width, height, preview_object_key, preview_width, preview_height, blurhash
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
