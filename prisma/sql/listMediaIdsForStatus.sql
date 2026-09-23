-- @param {String} $1:statusId
SELECT id FROM media_attachments WHERE status_id = $1 ORDER BY created_at
