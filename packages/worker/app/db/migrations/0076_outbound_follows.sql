-- A local account following a remote actor. `state` is `Requested` until the
-- actor's `Accept` of `follow_activity_id` arrives, then `Accepted`; a
-- `Reject` or an unfollow deletes the row. Rows are keyed by their own `id`
-- (the following-list cursor), so a `Move` can re-point `actor_uri` to the
-- new actor without losing the follow's options.
CREATE TABLE outbound_follows (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  follow_activity_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('Requested', 'Accepted')),
  reblogs INTEGER NOT NULL DEFAULT 1,
  notify INTEGER NOT NULL DEFAULT 0,
  languages_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, actor_uri),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

CREATE INDEX idx_outbound_follows_actor ON outbound_follows (actor_uri, state);
