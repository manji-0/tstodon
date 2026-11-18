-- @param {String} $1:viewerId
-- @param {String} $2:targetIdsJson
-- @param {Int} $3:limit
-- For each target, the first $3 accounts by username that the viewer follows
-- and that follow the target.
SELECT target_id, id FROM (
  SELECT familiar_follows.target_account_id AS target_id, a.id AS id,
         ROW_NUMBER() OVER (
           PARTITION BY familiar_follows.target_account_id ORDER BY a.username ASC
         ) AS position
  FROM follows viewer_follows
  JOIN follows familiar_follows
    ON familiar_follows.follower_account_id = viewer_follows.target_account_id
  JOIN accounts a
    ON a.id = familiar_follows.follower_account_id
  WHERE viewer_follows.follower_account_id = $1
    AND viewer_follows.kind = 'Accepted'
    AND familiar_follows.target_account_id IN (SELECT value FROM json_each($2))
    AND familiar_follows.kind = 'Accepted'
)
WHERE position <= $3
ORDER BY target_id, position
