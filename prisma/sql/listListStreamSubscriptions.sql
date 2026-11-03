-- @param {String} $1:hubsJson
SELECT hub, param FROM stream_subscriptions
WHERE stream = 'list' AND hub IN (SELECT value FROM json_each($1))
