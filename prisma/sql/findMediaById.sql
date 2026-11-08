-- @param {String} $1:id
SELECT id, account_id, status_id, object_key, content_type, created_at, description, focus_x, focus_y,
  width, height, preview_object_key, preview_width, preview_height, blurhash
FROM media_attachments
WHERE id = $1
