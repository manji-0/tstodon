-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:objectKey
-- @param {String} $4:contentType
-- @param {String} $5:createdAt
-- @param {String} $6:description
-- @param {Float} $7:focusX?
-- @param {Float} $8:focusY?
-- @param {String} $9:previewObjectKey?
-- @param {String} $10:metaJson
-- @param {String} $11:blurhash?
-- @param {Int} $12:isPrivate
INSERT INTO media_attachments (
  id, account_id, object_key, content_type, created_at,
  description, focus_x, focus_y, preview_object_key, meta_json, blurhash, is_private
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
