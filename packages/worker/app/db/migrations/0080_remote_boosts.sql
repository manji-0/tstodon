-- A remote actor's boost (`Announce`) of a local or cached remote status, kept
-- as a home timeline entry for the actor's local followers. `id` comes from
-- the same sortable id space as statuses, so boosts page with them. Exactly
-- one of `local_status_id` / `remote_status_id` names the boosted status, and
-- the row goes with that status, with the booster, or with an `Undo` of
-- `activity_id`. One boost per actor and status, as in Mastodon.
CREATE TABLE remote_boosts (
  id TEXT PRIMARY KEY,
  actor_uri TEXT NOT NULL,
  activity_id TEXT NOT NULL UNIQUE,
  local_status_id TEXT,
  remote_status_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((local_status_id IS NULL) <> (remote_status_id IS NULL)),
  UNIQUE (actor_uri, local_status_id),
  UNIQUE (actor_uri, remote_status_id),
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE,
  FOREIGN KEY (local_status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (remote_status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

-- The home timeline reads a followed actor's boosts in id order.
CREATE INDEX idx_remote_boosts_actor_id ON remote_boosts (actor_uri, id);
CREATE INDEX idx_remote_boosts_local_status ON remote_boosts (local_status_id);
CREATE INDEX idx_remote_boosts_remote_status ON remote_boosts (remote_status_id);
