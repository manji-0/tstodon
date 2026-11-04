-- @param {String} $1:notifiedAt
-- @param {String} $2:statusId
-- @param {String} $3:accountId
UPDATE remote_poll_own_votes SET expiry_notified_at = $1
WHERE status_id = $2 AND account_id = $3 AND expiry_notified_at IS NULL
