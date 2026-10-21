-- @param {String} $1:objectUri
SELECT id, object_uri, visibility, in_reply_to_uri FROM remote_statuses WHERE object_uri = $1
