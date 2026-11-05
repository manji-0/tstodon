-- @param {String} $1:id
-- @param {String} $2:legacyObjectKey
-- @param {String} $3:objectKey
UPDATE media_attachments SET object_key = $3
WHERE id = $1 AND object_key = $2 AND legacy_object_key = $2
RETURNING id
