-- @param {String} $1:pollId
SELECT p.options_json, p.expires_at, p.multiple, s.account_id
FROM polls p JOIN statuses s ON s.id = p.status_id
WHERE p.id = $1
