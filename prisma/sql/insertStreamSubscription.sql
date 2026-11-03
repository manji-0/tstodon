-- @param {String} $1:hub
-- @param {String} $2:stream
-- @param {String} $3:param
INSERT OR IGNORE INTO stream_subscriptions (hub, stream, param) VALUES ($1, $2, $3)
