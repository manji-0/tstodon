-- The end of a thread fetch, for Mastodon's async refresh of a context. The
-- job copies the `context_fetched_at` claim it ran for into
-- `context_refreshed_at`, so the two are equal once that pass has finished,
-- and records how many statuses it stored in `context_refresh_count`.
ALTER TABLE remote_statuses ADD COLUMN context_refreshed_at TEXT;
ALTER TABLE remote_statuses ADD COLUMN context_refresh_count INTEGER;
