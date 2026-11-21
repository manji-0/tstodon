-- @param {String} $1:accountId
-- @param {String} $2:typePrefix
-- The hour bucket of the account's latest group of a type prefix, and when
-- its newest notification was recorded: what Mastodon's
-- `notif-group/{account}/{prefix}` Redis key holds. Buckets of one prefix only
-- grow, so the latest is the greatest key; bucket numbers keep six digits
-- until 2084, so string order is number order. Two index seeks.
SELECT CAST(substr(n.group_key, length($2) + 2) AS INTEGER) AS bucket, n.created_at
FROM notifications n
WHERE n.account_id = $1
  AND n.group_key = (
    SELECT MAX(g.group_key) FROM notifications g
    WHERE g.account_id = $1 AND g.group_key > $2 || '-' AND g.group_key < $2 || '.'
  )
ORDER BY n.id DESC
LIMIT 1
