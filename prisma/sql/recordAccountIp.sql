-- @param {String} $1:accountId
-- @param {String} $2:ip
-- @param {String} $3:usedAt
INSERT INTO account_ips (account_id, ip, used_at)
SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = $1)
ON CONFLICT (account_id, ip) DO UPDATE SET used_at = excluded.used_at
