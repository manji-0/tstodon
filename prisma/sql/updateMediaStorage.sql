-- @param {String} $1:objectKey
-- @param {String} $2:previewObjectKey?
-- @param {Int} $3:isPrivate
-- @param {String} $4:mediaId
-- @param {String} $5:accountId
UPDATE media_attachments
SET object_key = $1, preview_object_key = $2, is_private = $3
WHERE id = $4 AND account_id = $5
