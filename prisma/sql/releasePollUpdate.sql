-- @param {String} $1:pollId
UPDATE polls SET update_queued_at = NULL WHERE id = $1
