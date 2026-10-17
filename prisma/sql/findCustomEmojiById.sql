-- @param {String} $1:id
SELECT id, shortcode, object_key, content_type, visible_in_picker, category
FROM custom_emojis WHERE id = $1 LIMIT 1
