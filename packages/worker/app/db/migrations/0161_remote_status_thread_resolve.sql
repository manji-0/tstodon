-- When the thread job of a remote reply whose parent was not stored was
-- queued (`ResolveRemoteThread`), as Mastodon's `Create#resolve_thread`
-- queues one `ThreadResolveWorker` a reply: set once, so a redelivered
-- `Create` or a chain that reaches the reply again queues no second job.
ALTER TABLE remote_statuses ADD COLUMN thread_resolve_queued_at TEXT;
