-- @param {String} $1:id
-- @param {String} $2:jobKind
-- @param {String} $3:reason
-- @param {String} $4:bodyJson
-- @param {Int} $5:attempts
-- @param {String} $6:error
-- @param {String} $7:seenAt
-- A dead-lettered outbox job; the same body again counts on its row.
INSERT INTO outbox_dead_jobs
  (id, job_kind, reason, body_json, attempts, dead_count, error, first_seen_at, last_seen_at)
VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $7)
ON CONFLICT (id) DO UPDATE SET
  reason = excluded.reason,
  attempts = excluded.attempts,
  dead_count = outbox_dead_jobs.dead_count + 1,
  error = excluded.error,
  last_seen_at = excluded.last_seen_at
