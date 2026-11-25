-- The collections a status tags (Mastodon 4.7 `TaggedObject` with
-- `ap_type: 'FeaturedCollection'`): a remote note's `FeaturedCollection`
-- tags (`Create#process_tagged_collection`,
-- `ProcessStatusUpdateService#update_tagged_objects!`,
-- `TaggedCollectionResolveWorker`) and the collections a local post links
-- (`ProcessLinksService`). Each row names one local or one remote
-- collection, and goes with its status or its collection. Rows are read in
-- the order they were written (`rowid`), as Mastodon reads `tagged_objects`.
CREATE TABLE status_tagged_collections (
  status_id TEXT NOT NULL,
  collection_id TEXT,
  remote_collection_id TEXT,
  CHECK ((collection_id IS NULL) <> (remote_collection_id IS NULL)),
  UNIQUE (status_id, collection_id),
  UNIQUE (status_id, remote_collection_id),
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (remote_collection_id) REFERENCES remote_collections(id) ON DELETE CASCADE
);

CREATE INDEX idx_status_tagged_collections_collection
  ON status_tagged_collections (collection_id);
CREATE INDEX idx_status_tagged_collections_remote_collection
  ON status_tagged_collections (remote_collection_id);

CREATE TABLE remote_status_tagged_collections (
  status_id TEXT NOT NULL,
  collection_id TEXT,
  remote_collection_id TEXT,
  CHECK ((collection_id IS NULL) <> (remote_collection_id IS NULL)),
  UNIQUE (status_id, collection_id),
  UNIQUE (status_id, remote_collection_id),
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (remote_collection_id) REFERENCES remote_collections(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_status_tagged_collections_collection
  ON remote_status_tagged_collections (collection_id);
CREATE INDEX idx_remote_status_tagged_collections_remote_collection
  ON remote_status_tagged_collections (remote_collection_id);
