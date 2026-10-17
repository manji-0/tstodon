-- @param {String} $1:shortcode
SELECT id, shortcode, object_key, content_type, visible_in_picker, category
FROM custom_emojis WHERE shortcode = $1 LIMIT 1
