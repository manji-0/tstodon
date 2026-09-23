-- @param {String} $1:accountId
-- @param {Int} $2:limit
SELECT id, account_id, kind, payload_json, created_at
FROM outbound_activities WHERE account_id = $1 ORDER BY id DESC LIMIT $2
