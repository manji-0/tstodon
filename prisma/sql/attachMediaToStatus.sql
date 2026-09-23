-- @param {String} $1:statusId
-- @param {Int} $2:isPrivate
-- @param {String} $3:mediaId
-- @param {String} $4:accountId
UPDATE media_attachments
SET status_id = $1, is_private = $2
WHERE id = $3 AND account_id = $4
