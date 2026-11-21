-- @param {String} $1:objectUrisJson
SELECT id, object_uri, visibility, in_reply_to_uri, in_reply_to_account_id, in_reply_to_actor_uri
FROM remote_statuses
WHERE object_uri IN (SELECT value FROM json_each($1))
