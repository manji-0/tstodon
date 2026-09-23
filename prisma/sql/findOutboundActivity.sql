-- @param {String} $1:id
SELECT id, account_id, kind, payload_json, created_at FROM outbound_activities WHERE id = $1
