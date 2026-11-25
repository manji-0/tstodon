-- Collections (Mastodon 4.7 `Collection`, `CollectionItem`): a local
-- account's curated list of accounts it features.
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  language TEXT,
  sensitive INTEGER NOT NULL,
  discoverable INTEGER NOT NULL,
  -- The topic, a normalized name in `tags`.
  tag_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_collections_account_created
  ON collections (account_id, created_at DESC);

-- An account a collection features. `state` is Mastodon's enum: a local
-- account is `accepted` at once, and its owner can `revoke` it.
CREATE TABLE collection_items (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (collection_id, account_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- `featured_in_collections`, and the collections an account is in.
CREATE INDEX idx_collection_items_account_collection
  ON collection_items (account_id, collection_id);

-- The collection an `added_to_collection` notification is about is its
-- item's (`collection_item_id`, kept after the item goes, as Mastodon keeps
-- the notification and renders `collection: null`); a `collection_update`
-- names the collection, and goes with it (`dependent: :destroy`).
ALTER TABLE notifications ADD COLUMN collection_item_id TEXT;
ALTER TABLE notifications ADD COLUMN collection_id TEXT
  REFERENCES collections(id) ON DELETE CASCADE;
