-- @param {String} $1:id
-- @param {Int} $2:disabled
-- @param {String} $3:now
UPDATE custom_emojis
SET disabled = $2, updated_at = $3
WHERE id = $1
RETURNING id
