-- @param {String} $1:accountId
-- @param {String} $2:fromAccountIdsJson
-- @param {String} $3:createdAt
-- Hide the notifications the senders' requests hold, before the requests go.
INSERT INTO notification_dismissals (account_id, notification_id, created_at)
SELECT r.account_id, r.notification_id, $3 FROM notification_requests r
JOIN notifications n ON n.id = r.notification_id AND n.account_id = r.account_id
WHERE r.account_id = $1 AND r.from_account_id IN (SELECT value FROM json_each($2))
ON CONFLICT(account_id, notification_id) DO NOTHING
