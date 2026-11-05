-- @param {Int} $1:limit
SELECT id, account_id, object_key, legacy_object_key
FROM media_attachments
WHERE legacy_object_key IS NOT NULL
ORDER BY id
LIMIT $1
