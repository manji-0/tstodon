-- @param {String} $1:hub
DELETE FROM stream_subscriptions WHERE hub = $1
