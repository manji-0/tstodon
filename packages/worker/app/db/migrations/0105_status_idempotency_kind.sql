-- What an `Idempotency-Key` points at: `Pending` while the first request runs,
-- then `Status` (status_id is a statuses id) or `ScheduledStatus` (status_id is
-- a scheduled_statuses id), so a retry replays the right document.
ALTER TABLE status_idempotency ADD COLUMN kind TEXT NOT NULL DEFAULT 'Status';

UPDATE status_idempotency SET kind = 'Pending' WHERE status_id = '';

UPDATE status_idempotency SET kind = 'ScheduledStatus'
WHERE status_id IN (SELECT id FROM scheduled_statuses);
