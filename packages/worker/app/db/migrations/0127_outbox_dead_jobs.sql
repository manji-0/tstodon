-- Outbox queue jobs that will not run again on their own: the dead-letter
-- queue `tstodon-outbox-dlq` (consumer `app/queues/tstodon-outbox-dlq.ts`)
-- stores each message it receives here. `id` is the SHA-256 (hex) of
-- `body_json`, so the same job dead-lettered again updates its row
-- (`dead_count`, `last_seen_at`, `attempts`, `error`) instead of adding one.
-- `reason` is why it died: `RetriesExhausted` (the job returned retry on its
-- last attempt and the handler sent it here), `HandlerFailed` (Queues
-- dead-lettered a valid job after `max_retries`: the handler threw or the
-- invocation failed) or `Unparseable` (the body is not an `OutboxJob`).
-- `job_kind` is the body's `kind` when it has one. The `RequeueDeadOutboxJobs`
-- job sends rows back to `tstodon-outbox-process` and deletes them.
CREATE TABLE IF NOT EXISTS outbox_dead_jobs (
    id TEXT NOT NULL PRIMARY KEY,
    job_kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    body_json TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    dead_count INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

-- Inspection by kind and the requeue job's pages (oldest first).
CREATE INDEX IF NOT EXISTS idx_outbox_dead_jobs_kind
    ON outbox_dead_jobs (job_kind, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_outbox_dead_jobs_first_seen
    ON outbox_dead_jobs (first_seen_at, id);
