-- Keep the status that triggered a held notification, so the request document
-- reports an exact `last_status` without scanning the notification list.

ALTER TABLE notification_requests ADD COLUMN status_id TEXT;
