-- Grouped notification pages seek an account's notifications in id order
-- (`pageNotificationGroupsOlder` / `Newer`), and a group's members are found
-- by status (`summarizeNotificationGroups`, `dismissNotificationGroup`).
CREATE INDEX idx_notifications_account_id ON notifications (account_id, id);
CREATE INDEX idx_notifications_account_status ON notifications (account_id, status_id);
