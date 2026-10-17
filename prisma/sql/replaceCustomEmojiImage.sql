-- @param {String} $1:id
-- @param {String} $2:objectKey
-- @param {String} $3:contentType
-- @param {String} $4:now
UPDATE custom_emojis
SET object_key = $2, content_type = $3, updated_at = $4
WHERE id = $1
RETURNING id
