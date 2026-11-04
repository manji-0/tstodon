-- @param {String} $1:id
-- @param {String} $2:accountId
SELECT id, account_id, from_account_id, kind, status_id, target_account_id, report_id, severance_event_id, created_at
FROM notifications
WHERE id = $1 AND account_id = $2
LIMIT 1
