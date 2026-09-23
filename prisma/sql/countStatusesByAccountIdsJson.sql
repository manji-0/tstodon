-- @param {String} $1:idsJson
SELECT account_id, COUNT(*) AS count
FROM statuses
WHERE account_id IN (SELECT value FROM json_each($1))
GROUP BY account_id
