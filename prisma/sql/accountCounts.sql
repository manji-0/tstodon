-- @param {String} $1:accountId
SELECT
  (SELECT COUNT(*) FROM follows WHERE target_account_id = $1 AND kind = 'Accepted') AS followers,
  (SELECT COUNT(*) FROM follows WHERE follower_account_id = $1 AND kind = 'Accepted')
    + (SELECT COUNT(*) FROM outbound_follows WHERE account_id = $1 AND state = 'Accepted') AS following,
  (SELECT COUNT(*) FROM statuses WHERE account_id = $1) AS statuses
