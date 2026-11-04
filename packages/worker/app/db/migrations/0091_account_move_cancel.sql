-- A cancelled redirect keeps its `account_moves` row: the cooldown counts
-- from `moved_at` whether or not the redirect still stands.
ALTER TABLE account_moves ADD COLUMN cancelled_at TEXT;

-- The local accounts that blocked, muted or noted an account, in account id order,
-- for carrying them over to the account it moved to page by page. Local
-- targets are keyed by their actor URI like remote ones.
CREATE INDEX idx_blocks_target_actor_uri ON blocks(target_actor_uri, blocker_account_id);
CREATE INDEX idx_mutes_target_actor_uri ON mutes(target_actor_uri, account_id);
CREATE INDEX idx_account_notes_target_actor_uri ON account_notes(target_actor_uri, account_id);
