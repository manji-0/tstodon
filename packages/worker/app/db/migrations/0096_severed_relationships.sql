-- Severed relationships (`/severed_relationships`, the `severed_relationships`
-- notification). One `relationship_severance_events` row is a moderation
-- decision that removed follows: a suspended server (`domain_block`), a
-- suspended remote account (`account_suspension`), or a server a user blocked
-- (`user_domain_block`). `target_name` is the domain or the account address.
-- `purged` marks an event whose server an admin purged (nothing sets it yet).
--
-- `account_severance_events` is one local account's view of an event, the row
-- the notification and the CSV downloads point at, with the counts it lost.
-- `severed_relationships` lists the lost follows of an event. `direction` is
-- `active` for a follow by the local account and `passive` for a follow of it;
-- the remote account is kept as its address (`remote_acct`), so the list
-- outlives the cached actor. A follow row's id is reused as the row's id.
CREATE TABLE relationship_severance_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('domain_block', 'user_domain_block', 'account_suspension')),
  target_name TEXT NOT NULL,
  purged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE account_severance_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  followers_count INTEGER NOT NULL DEFAULT 0,
  following_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, account_id),
  FOREIGN KEY (event_id) REFERENCES relationship_severance_events(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_severance_events_account ON account_severance_events (account_id, id);

CREATE TABLE severed_relationships (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  local_account_id TEXT NOT NULL,
  remote_acct TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('active', 'passive')),
  show_reblogs INTEGER,
  notify INTEGER,
  languages_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES relationship_severance_events(id) ON DELETE CASCADE,
  FOREIGN KEY (local_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_severed_relationships_event
  ON severed_relationships (event_id, local_account_id, direction, id);

-- The event a `severed_relationships` notification reports.
ALTER TABLE notifications ADD COLUMN severance_event_id TEXT;
