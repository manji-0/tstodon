-- An account is in a remote collection at most once, as Mastodon's unique
-- `collection_items (account_id, collection_id)`: a repeated `FeatureRequest`
-- adds nothing, and an item that verifies for an account already in the
-- collection keeps its state. A local account is `account_id`, a remote one
-- `actor_uri`.
-- void:allow-destructive
-- The account index is replaced by a unique one on the same columns; no
-- deployment holds rows yet, so none is dropped.
DROP INDEX idx_remote_collection_items_account;

CREATE UNIQUE INDEX idx_remote_collection_items_account
  ON remote_collection_items (account_id, collection_id) WHERE account_id IS NOT NULL;

DROP INDEX idx_remote_collection_items_actor;

CREATE UNIQUE INDEX idx_remote_collection_items_actor
  ON remote_collection_items (actor_uri, collection_id) WHERE actor_uri IS NOT NULL;

-- `index_collection_items_on_approval_uri`: one item per authorization.
CREATE UNIQUE INDEX idx_remote_collection_items_approval
  ON remote_collection_items (approval_uri) WHERE approval_uri IS NOT NULL;

-- Mastodon's `collection_reports.collection_id` foreign key (`on_delete:
-- :cascade`). A report names a local or a remote collection, so a trigger on
-- each table stands in for it.
CREATE TRIGGER report_collections_leave_with_collection AFTER DELETE ON collections
BEGIN
  DELETE FROM report_collections WHERE collection_id = OLD.id;
END;

CREATE TRIGGER report_collections_leave_with_remote_collection AFTER DELETE ON remote_collections
BEGIN
  DELETE FROM report_collections WHERE collection_id = OLD.id;
END;
