-- @param {String} $1:id
SELECT id, account_id, status_id, object_key, content_type, created_at,
       COALESCE(description, '') AS description, focus_x, focus_y,
       preview_object_key, COALESCE(meta_json, '{}') AS meta_json, blurhash,
       COALESCE(is_private, 1) AS is_private
FROM media_attachments
WHERE id = $1
