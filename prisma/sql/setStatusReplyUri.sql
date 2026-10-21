-- @param {String} $1:statusId
-- @param {String} $2:inReplyToUri
UPDATE statuses SET in_reply_to_uri = $2 WHERE id = $1
