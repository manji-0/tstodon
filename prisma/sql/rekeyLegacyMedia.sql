-- @param {String} $1:id
-- @param {String} $2:legacyObjectKey
-- @param {String} $3:objectKey
-- @param {Int} $4:legacyStored
UPDATE media_attachments SET object_key = $3,
    legacy_object_key = CASE WHEN $4 = 1 THEN $2 END
WHERE id = $1 AND object_key = $2
RETURNING id
