-- @param {String} $1:id
-- @param {String} $2:accountId
SELECT n.id, n.account_id, n.from_account_id, n.kind, n.status_id, n.target_account_id, n.report_id, n.severance_event_id, n.created_at,
  n.id IN (SELECT notification_id FROM notification_requests WHERE account_id = $2) AS held
FROM notifications n
WHERE n.id = $1 AND n.account_id = $2
LIMIT 1
