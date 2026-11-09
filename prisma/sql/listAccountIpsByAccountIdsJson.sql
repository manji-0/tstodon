-- @param {String} $1:accountIdsJson
-- The addresses of these accounts, most recently used first.
SELECT account_id, ip, used_at FROM account_ips
WHERE account_id IN (SELECT value FROM json_each($1))
ORDER BY used_at DESC
