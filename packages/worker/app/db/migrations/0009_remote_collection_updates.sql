-- The remote collection a `collection_update` notification is about, for a
-- local account a remote collection features
-- (`NotifyOfCollectionUpdateService` after `ProcessFeaturedCollectionService`).
-- `collection_id` names local collections only; this column names the
-- remote one, and the notification goes with it (`dependent: :destroy`).
ALTER TABLE notifications ADD COLUMN remote_collection_id TEXT
  REFERENCES remote_collections(id) ON DELETE CASCADE;

-- The `fetched_at` of the actor's document whose `featuredCollections` was
-- last queued for reading (`SynchronizeFeaturedCollectionsCollectionWorker`,
-- which each processing of the actor queues). NULL until the first time.
ALTER TABLE remote_actors ADD COLUMN collections_synced_at TEXT;

CREATE INDEX idx_remote_actors_collections_due
  ON remote_actors (fetched_at)
  WHERE json_extract(profile_json, '$.featuredCollectionsUri') IS NOT NULL
    AND (collections_synced_at IS NULL OR collections_synced_at < fetched_at);
