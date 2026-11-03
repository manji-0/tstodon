-- @param {String} $1:idsJson
SELECT account_id, COUNT(*) AS count
FROM (
  SELECT follower_account_id AS account_id FROM follows
  WHERE kind = 'Accepted' AND follower_account_id IN (SELECT value FROM json_each($1))
  UNION ALL
  SELECT account_id FROM outbound_follows
  WHERE state = 'Accepted' AND account_id IN (SELECT value FROM json_each($1))
)
GROUP BY account_id
