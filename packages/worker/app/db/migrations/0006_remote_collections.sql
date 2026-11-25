-- A remote account's collections (Mastodon 4.7 `Collection` with
-- `local: false`), as `ProcessFeaturedCollectionService` stores what its
-- `featuredCollections`, `Add`, `Update` and `Remove` carry.
CREATE TABLE remote_collections (
  id TEXT PRIMARY KEY,
  actor_uri TEXT NOT NULL,
  uri TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  -- The summary as sent (`description_html`), sanitized when rendered.
  description_html TEXT NOT NULL,
  language TEXT,
  sensitive INTEGER NOT NULL,
  discoverable INTEGER NOT NULL,
  original_number_of_items INTEGER NOT NULL,
  tag_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

CREATE INDEX idx_remote_collections_actor ON remote_collections (actor_uri, created_at DESC);

-- An item of a remote collection (`ProcessFeaturedItemService`): `uri` is
-- its id, `object_uri` the featured actor. A local account is `accepted`
-- when it accepted the owner's `FeatureRequest`; a remote one when its
-- authorization verified, when `actor_uri` names it.
CREATE TABLE remote_collection_items (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  account_id TEXT,
  actor_uri TEXT,
  object_uri TEXT,
  uri TEXT,
  position INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'revoked')),
  activity_uri TEXT,
  approval_uri TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (collection_id, uri),
  FOREIGN KEY (collection_id) REFERENCES remote_collections(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

-- `in_collections` and a local account's `added_to_collection`.
CREATE INDEX idx_remote_collection_items_account
  ON remote_collection_items (account_id, collection_id) WHERE account_id IS NOT NULL;
