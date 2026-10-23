-- Local notes can mention remote accounts (`@user@domain`):
-- `status_remote_mentions` records the remote actors a local note addresses,
-- so the note carries their Mention tags, is delivered to their inboxes, and
-- lists them as conversation participants.

CREATE TABLE status_remote_mentions (
  status_id TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  PRIMARY KEY (status_id, actor_uri),
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

CREATE INDEX idx_status_remote_mentions_actor ON status_remote_mentions (actor_uri);
