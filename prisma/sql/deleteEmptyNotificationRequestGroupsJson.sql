-- @param {String} $1:accountId
-- @param {String} $2:fromAccountIdsJson
-- Drop the senders' request groups once their last held notification is gone.
DELETE FROM notification_request_groups
WHERE account_id = $1 AND from_account_id IN (SELECT value FROM json_each($2))
  AND NOT EXISTS (
    SELECT 1 FROM notification_requests n
    WHERE n.account_id = notification_request_groups.account_id
      AND n.from_account_id = notification_request_groups.from_account_id
  )
