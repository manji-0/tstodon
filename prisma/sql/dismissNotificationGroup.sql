-- @param {String} $1:accountId
-- @param {String} $2:createdAt
-- @param {String} $3:notificationId
-- @param {String} $4:groupKey
-- Every notification a group key names, as Mastodon's `by_group_key`: blocked,
-- muted and unavailable senders included. An `ungrouped-<id>` key names its
-- notification, held or not; another key the notifications that stored it.
-- Each arm finds its rows through an index: by id, or by stored key.
INSERT INTO notification_dismissals (account_id, notification_id, created_at)
SELECT $1, n.id, $2 FROM notifications n
WHERE n.account_id = $1 AND n.id = $3
UNION ALL
SELECT $1, n.id, $2 FROM notifications n
WHERE n.account_id = $1 AND n.group_key = $4
ON CONFLICT(account_id, notification_id) DO NOTHING
