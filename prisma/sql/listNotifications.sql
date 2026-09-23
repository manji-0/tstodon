-- @param {String} $1:accountId
-- @param {Int} $2:limit
SELECT id, account_id, from_account_id, kind, status_id, created_at
FROM notifications WHERE account_id = $1 ORDER BY id DESC LIMIT $2
