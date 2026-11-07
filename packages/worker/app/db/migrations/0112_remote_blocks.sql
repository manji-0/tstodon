-- A remote actor's Block of a local account. `blocks` only records blocks a
-- local account makes. Mastodon stores the other direction so
-- `StatusPolicy#show?` (`author_blocking?`) can hide that author's public
-- posts, and so a relationship reports `blocked_by`.

CREATE TABLE remote_blocks (
  actor_uri TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_uri, account_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_blocks_account
  ON remote_blocks (account_id, actor_uri);
