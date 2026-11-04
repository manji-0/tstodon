-- The accounts a local account says it moved from (Mastodon's
-- `account_aliases`), published as `alsoKnownAs` on its actor. `actor_uri` is
-- what the handle resolved to when the alias was added.
CREATE TABLE account_aliases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  acct TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, actor_uri),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
