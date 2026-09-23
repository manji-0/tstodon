-- @param {String} $1:statusId
-- @param {String} $2:mediaId
-- @param {String} $3:accountId
UPDATE media_attachments SET status_id = $1 WHERE id = $2 AND account_id = $3
