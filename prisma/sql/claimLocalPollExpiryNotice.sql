-- @param {String} $1:notifiedAt
-- @param {String} $2:pollId
-- @param {String} $3:accountId
UPDATE poll_votes SET expiry_notified_at = $1
WHERE poll_id = $2 AND account_id = $3 AND expiry_notified_at IS NULL
