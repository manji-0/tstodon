-- @param {String} $1:now
-- @param {Int} $2:limit
SELECT p.id, p.status_id, s.account_id
FROM polls p
JOIN statuses s ON s.id = p.status_id
WHERE p.expires_at <= $1 AND p.expiry_notified_at IS NULL
ORDER BY p.expires_at ASC
LIMIT $2
