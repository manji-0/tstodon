-- @param {String} $1:accountId
-- @param {String} $2:clearedAt
INSERT INTO notification_clear_markers (account_id, cleared_at)
VALUES ($1, $2)
ON CONFLICT(account_id) DO UPDATE SET cleared_at = excluded.cleared_at
