-- @param {String} $1:accountId
SELECT object_key FROM media_attachments WHERE account_id = $1
