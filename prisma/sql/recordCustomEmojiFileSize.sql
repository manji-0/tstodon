-- @param {String} $1:id
-- @param {String} $2:objectKey
-- @param {Int} $3:fileSize
-- As `recordMediaFileSizes`, for a custom emoji's image still at `objectKey`.
UPDATE custom_emojis SET image_file_size = $3
WHERE id = $1 AND object_key = $2 AND image_file_size IS NULL
