-- @param {String} $1:idsJson
SELECT account_id, statuses_count, followers_count, following_count
FROM account_stats
WHERE account_id IN (SELECT value FROM json_each($1))
