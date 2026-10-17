-- @param {String} $1:id
DELETE FROM custom_emojis WHERE id = $1
RETURNING object_key
