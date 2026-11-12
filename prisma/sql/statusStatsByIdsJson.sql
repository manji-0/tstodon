-- @param {String} $1:idsJson
SELECT status_id, favourites_count, reblogs_count, quotes_count, replies_count
FROM status_stats
WHERE status_id IN (SELECT value FROM json_each($1))
