-- @param {String} $1:idsJson
SELECT follower_account_id AS account_id, COUNT(*) AS count
FROM follows
WHERE kind = 'Accepted' AND follower_account_id IN (SELECT value FROM json_each($1))
GROUP BY follower_account_id
