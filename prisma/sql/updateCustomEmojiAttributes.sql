-- @param {String} $1:id
-- @param {Int} $2:visibleInPicker
-- @param {String} $3:category?
-- @param {String} $4:now
UPDATE custom_emojis
SET visible_in_picker = $2, category = $3, updated_at = $4
WHERE id = $1
RETURNING id
