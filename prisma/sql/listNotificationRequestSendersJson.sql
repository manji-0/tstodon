-- @param {String} $1:accountId
-- @param {String} $2:idsJson
-- The senders whose requests the ids name, by request id. A group whose held
-- notifications are all gone names no request, as `findNotificationRequest`
-- finds none for it.
SELECT g.from_account_id FROM notification_request_groups g
WHERE g.account_id = $1
  AND g.id IN (SELECT value FROM json_each($2))
  AND EXISTS (
    SELECT 1 FROM notification_requests n
    WHERE n.account_id = g.account_id AND n.from_account_id = g.from_account_id
  )
