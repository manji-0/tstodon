-- @param {String} $1:now
-- @param {Int} $2:limit
-- Local accounts that voted on a remote poll which has ended and have not been told yet.
SELECT DISTINCT v.status_id, v.account_id, s.actor_uri
FROM remote_poll_own_votes v
JOIN remote_statuses s ON s.id = v.status_id
WHERE v.expiry_notified_at IS NULL
  AND json_extract(s.poll_json, '$.ends.at') <= $1
ORDER BY v.status_id, v.account_id
LIMIT $2
