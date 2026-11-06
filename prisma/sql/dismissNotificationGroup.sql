-- @param {String} $1:accountId
-- @param {String} $2:createdAt
-- @param {String} $3:notificationId
-- @param {String} $4:groupType
-- @param {String} $5:groupTarget
-- Every notification a group key names, as Mastodon's `by_group_key`: blocked,
-- muted and unavailable senders included. A type and target key leaves out the
-- notifications the policy holds, which Mastodon gives no group key; an
-- `ungrouped-<id>` key names its notification whether it is held or not. Each
-- arm finds its rows through an index: by id, by status, or by sender.
INSERT INTO notification_dismissals (account_id, notification_id, created_at)
SELECT $1, n.id, $2 FROM notifications n
WHERE n.account_id = $1 AND n.id = $3
UNION ALL
SELECT $1, n.id, $2 FROM notifications n
WHERE n.account_id = $1 AND n.status_id = $5 AND n.status_id <> '' AND n.kind = $4
  AND n.id NOT IN (SELECT notification_id FROM notification_requests WHERE account_id = $1)
UNION ALL
SELECT $1, n.id, $2 FROM notifications n
WHERE n.account_id = $1 AND n.from_account_id = $5 AND COALESCE(n.status_id, '') = ''
  AND n.kind = $4
  AND n.id NOT IN (SELECT notification_id FROM notification_requests WHERE account_id = $1)
ON CONFLICT(account_id, notification_id) DO NOTHING
