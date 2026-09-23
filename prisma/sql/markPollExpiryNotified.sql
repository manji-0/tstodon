-- @param {String} $1:notifiedAt
-- @param {String} $2:pollId
UPDATE polls SET expiry_notified_at = $1
WHERE id = $2 AND expiry_notified_at IS NULL
