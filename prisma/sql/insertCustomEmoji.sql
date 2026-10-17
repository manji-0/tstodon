-- @param {String} $1:id
-- @param {String} $2:shortcode
-- @param {String} $3:objectKey
-- @param {String} $4:contentType
-- @param {Int} $5:visibleInPicker
-- @param {String} $6:category?
-- @param {String} $7:now
INSERT INTO custom_emojis (
    id, shortcode, object_key, content_type, visible_in_picker, category, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
