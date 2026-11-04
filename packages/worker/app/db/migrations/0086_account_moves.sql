-- Where a local account moved to (Mastodon's `moved_to_account` with its
-- latest `AccountMigration`): the target's actor URI and handle, and when.
-- One row per account; moving again after the cooldown replaces it.
CREATE TABLE account_moves (
  account_id TEXT PRIMARY KEY,
  acct TEXT NOT NULL,
  target_uri TEXT NOT NULL,
  moved_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- The local follows of an account in id order, for moving them page by page.
CREATE INDEX idx_follows_target_id ON follows(target_account_id, id);
