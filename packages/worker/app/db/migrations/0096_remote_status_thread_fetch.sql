-- When a cached remote status last had its thread (the notes above it and
-- the replies under it) fetched from its origin. Opening the status claims
-- it, as a profile view claims `remote_actors.outbox_fetched_at`, so the fetch
-- runs once per TTL and off the request path.
ALTER TABLE remote_statuses ADD COLUMN context_fetched_at TEXT;
