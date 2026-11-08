-- @param {String} $1:statusId
-- Forget the remote actors a cached remote note mentions, before they are written again.
DELETE FROM remote_status_remote_mentions WHERE status_id = $1
