-- @param {String} $1:idsJson
SELECT target_account_id AS account_id, COUNT(*) AS count
FROM follows
WHERE kind = 'Accepted' AND target_account_id IN (SELECT value FROM json_each($1))
GROUP BY target_account_id
