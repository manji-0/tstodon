-- When the thread job of a remote reply whose parent was not stored was
-- queued (`ResolveRemoteThread`), as Mastodon's `Create#resolve_thread`
-- queues one `ThreadResolveWorker` a reply: a redelivered `Create` or a chain
-- that reaches the reply again queues no second job. A claim older than an
-- hour counts as one whose job was lost.
ALTER TABLE remote_statuses ADD COLUMN thread_resolve_queued_at TEXT;
