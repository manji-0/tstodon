-- @param {String} $1:streamsJson
-- @param {String} $2:hubsJson
SELECT hub, stream, param FROM stream_subscriptions
WHERE hub IN (SELECT value FROM json_each($2))
  AND stream IN (SELECT value FROM json_each($1))
