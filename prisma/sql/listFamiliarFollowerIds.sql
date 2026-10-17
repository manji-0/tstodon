-- @param {String} $1:viewerId
-- @param {String} $2:targetId
-- @param {Int} $3:limit
SELECT DISTINCT a.id FROM follows viewer_follows
JOIN follows familiar_follows
  ON familiar_follows.follower_account_id = viewer_follows.target_account_id
JOIN accounts a
  ON a.id = familiar_follows.follower_account_id
WHERE viewer_follows.follower_account_id = $1
  AND viewer_follows.kind = 'Accepted'
  AND familiar_follows.target_account_id = $2
  AND familiar_follows.kind = 'Accepted'
ORDER BY a.username ASC
LIMIT $3
