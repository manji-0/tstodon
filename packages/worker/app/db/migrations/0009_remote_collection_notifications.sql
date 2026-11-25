-- The remote collection a `collection_update` notification is about, for a
-- local account a remote collection features
-- (`NotifyOfCollectionUpdateService` after `ProcessFeaturedCollectionService`).
-- `collection_id` names local collections only; this column names the
-- remote one, and the notification goes with it (`dependent: :destroy`).
ALTER TABLE notifications ADD COLUMN remote_collection_id TEXT
  REFERENCES remote_collections(id) ON DELETE CASCADE;
