-- @param {String} $1:idsJson
SELECT account_id, COUNT(*) AS count
FROM (
  SELECT target_account_id AS account_id FROM follows
  WHERE kind = 'Accepted' AND target_account_id IN (SELECT value FROM json_each($1))
  UNION ALL
  SELECT target_account_id AS account_id FROM remote_follows
  WHERE follow_kind = 'Accepted' AND target_account_id IN (SELECT value FROM json_each($1))
)
GROUP BY account_id
