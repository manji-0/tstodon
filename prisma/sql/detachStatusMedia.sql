-- @param {String} $1:statusId
-- @param {String} $2:accountId
UPDATE media_attachments SET status_id = NULL
WHERE status_id = $1 AND account_id = $2
