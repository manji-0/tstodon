-- @param {String} $1:statusId
-- @param {String} $2:mediaId
-- @param {String} $3:accountId
-- @param {Int} $4:position
UPDATE media_attachments SET status_id = $1, position = $4 WHERE id = $2 AND account_id = $3
