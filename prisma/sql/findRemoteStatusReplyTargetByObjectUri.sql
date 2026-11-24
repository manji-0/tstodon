-- @param {String} $1:objectUri
SELECT id, object_uri, visibility, limited_from_direct, in_reply_to_uri, in_reply_to_account_id, in_reply_to_actor_uri
FROM remote_statuses WHERE object_uri = $1
