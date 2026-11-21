-- Mastodon stores a notification's group key when it records it
-- (`Notification::Groups#set_group_key!`): `{type prefix}-{hour bucket}`,
-- where a favourite or reblog's prefix is `{type}-{status id}` and a follow or
-- `admin.sign_up`'s is its type. A notification of another type, or one the
-- policy held, has none, and is listed as `ungrouped-{id}`.
--
-- Each existing groupable row is keyed by the hour it was recorded in. Mastodon
-- keeps a group's first hour for up to twelve hours; the rows written before
-- this migration do not, so a group that ran across hours splits by hour. A
-- row held now gets no key, as Mastodon gives a filtered notification none.

ALTER TABLE notifications ADD COLUMN group_key TEXT;

UPDATE notifications
  SET group_key = CASE
      WHEN kind IN ('favourite', 'reblog') THEN kind || '-' || COALESCE(status_id, '')
      ELSE kind
    END || '-' || (CAST(strftime('%s', created_at) AS INTEGER) / 3600)
  WHERE kind IN ('favourite', 'reblog', 'follow', 'admin.sign_up')
    AND id NOT IN (SELECT notification_id FROM notification_requests);

-- A group's members by key, newest first (`summarizeNotificationGroups`,
-- `dismissNotificationGroup`), and a type prefix's latest bucket
-- (`findNotificationGroupBucket`), as Mastodon's
-- `index_notifications_on_account_id_and_group_key`.
CREATE INDEX idx_notifications_account_group
  ON notifications (account_id, group_key, id)
  WHERE group_key IS NOT NULL;
