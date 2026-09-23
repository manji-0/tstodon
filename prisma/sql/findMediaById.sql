-- @param {String} $1:id
SELECT id, account_id, status_id, object_key, content_type, created_at
FROM media_attachments
WHERE id = $1
