-- @param {String} $1:hub
-- @param {String} $2:stream
-- @param {String} $3:param
DELETE FROM stream_subscriptions WHERE hub = $1 AND stream = $2 AND param = $3
