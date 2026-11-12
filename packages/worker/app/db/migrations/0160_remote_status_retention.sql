-- Remote status retention (server/remote-status-retention.ts): the hourly
-- cron examines a slice of cached remote statuses after this cursor, in id
-- order, and deletes the stale ones nothing local needs. The cursor wraps to
-- '' after a short slice; `completed_at` stays NULL.
INSERT OR IGNORE INTO backfill_cursors (name) VALUES ('remote_status_retention');
