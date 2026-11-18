-- @param {String} $1:accountId
-- @param {String} $2:idsJson
-- The senders whose requests the ids name: by request id, or by sender id as
-- ids handed out before the request groups existed do.
SELECT from_account_id FROM notification_request_groups
WHERE account_id = $1 AND id IN (SELECT value FROM json_each($2))
UNION
SELECT from_account_id FROM notification_request_groups
WHERE account_id = $1 AND from_account_id IN (SELECT value FROM json_each($2))
