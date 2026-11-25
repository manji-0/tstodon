-- A local collection may feature a remote account (Mastodon 4.7
-- `CollectionItem` with a remote `account`): the item is `pending` until the
-- account's server answers the `FeatureRequest` (`activity_uri`) with an
-- `Accept` whose `result` is its authorization (`approval_uri`).
--
-- SQLite cannot make `account_id` nullable in place, so the table is rebuilt.
-- No foreign key names `collection_items`, so dropping the old table removes
-- nothing else.
-- void:allow-destructive
CREATE TABLE collection_items_rebuilt (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  -- A local featured account, or else a remote one by its actor URI.
  account_id TEXT,
  actor_uri TEXT,
  position INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'revoked')),
  activity_uri TEXT,
  approval_uri TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((account_id IS NULL) <> (actor_uri IS NULL)),
  UNIQUE (collection_id, account_id),
  UNIQUE (collection_id, actor_uri),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

INSERT INTO collection_items_rebuilt
  (id, collection_id, account_id, position, state, created_at, updated_at)
SELECT id, collection_id, account_id, position, state, created_at, updated_at
FROM collection_items;

DROP TABLE collection_items;

ALTER TABLE collection_items_rebuilt RENAME TO collection_items;

CREATE INDEX idx_collection_items_account_collection
  ON collection_items (account_id, collection_id);

CREATE INDEX idx_collection_items_actor
  ON collection_items (actor_uri) WHERE actor_uri IS NOT NULL;

-- The `Accept` or `Reject` of a `FeatureRequest` names it by `activity_uri`;
-- the `Delete` of an authorization by `approval_uri`.
CREATE INDEX idx_collection_items_activity
  ON collection_items (activity_uri) WHERE activity_uri IS NOT NULL;

CREATE INDEX idx_collection_items_approval
  ON collection_items (approval_uri) WHERE approval_uri IS NOT NULL;
