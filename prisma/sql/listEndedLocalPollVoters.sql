-- @param {String} $1:now
-- @param {Int} $2:limit
-- Local accounts that voted on a local poll which has ended and have not been
-- told yet. The author is told as the author, not as a voter.
SELECT DISTINCT v.poll_id, p.status_id, v.account_id, s.account_id AS author_id
FROM poll_votes v
JOIN polls p ON p.id = v.poll_id
JOIN statuses s ON s.id = p.status_id
WHERE v.expiry_notified_at IS NULL
  AND p.expires_at <= $1
  AND v.account_id <> s.account_id
ORDER BY v.poll_id, v.account_id
LIMIT $2
