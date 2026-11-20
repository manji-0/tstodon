-- @param {String} $1:actorUri
-- @param {Int} $2:limit
SELECT m.status_id, m.account_id FROM (
  SELECT id FROM remote_statuses
  WHERE actor_uri = $1 AND visibility IN ('limited', 'direct')
  ORDER BY id DESC LIMIT $2
) s
CROSS JOIN remote_status_mentions m ON m.status_id = s.id
WHERE EXISTS (
  SELECT 1 FROM outbound_follows f
  WHERE f.account_id = m.account_id AND f.actor_uri = $1 AND f.state = 'Accepted'
)
ORDER BY m.status_id DESC, m.account_id
