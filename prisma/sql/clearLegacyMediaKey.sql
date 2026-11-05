-- @param {String} $1:id
-- @param {String} $2:legacyObjectKey
UPDATE media_attachments SET legacy_object_key = NULL
WHERE id = $1 AND legacy_object_key = $2
RETURNING id
