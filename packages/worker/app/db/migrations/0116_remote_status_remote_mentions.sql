-- The remote actors a cached remote note mentions (its `Mention` tags that do
-- not name a local account), so the `Delete` of a quote stamp reaches them as
-- Mastodon's `StatusReachFinder` reaches a status's mentioned accounts. Local
-- accounts stay in `remote_status_mentions`, with its silent mentions. Keyed
-- by actor URI with no foreign key to `remote_actors`: a mention of an actor
-- not cached yet is kept, and reach only resolves the actors cached by then.

CREATE TABLE remote_status_remote_mentions (
  status_id TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  PRIMARY KEY (status_id, actor_uri),
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);
