-- A remote actor's `outbox` and `featured` collections, read from its actor
-- document, and when its outbox was last fetched to backfill its profile.
-- Actors cached before this have no collection URIs until the backfill
-- refetches their document.
ALTER TABLE remote_actors ADD COLUMN outbox_uri TEXT;
ALTER TABLE remote_actors ADD COLUMN featured_uri TEXT;
ALTER TABLE remote_actors ADD COLUMN outbox_fetched_at TEXT;
