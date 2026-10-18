-- @param {String} $1:id
-- @param {String} $2:accountId
DELETE FROM media_attachments WHERE id = $1 AND account_id = $2
RETURNING object_key
