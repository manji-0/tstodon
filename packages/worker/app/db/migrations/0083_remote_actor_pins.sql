-- The notes a remote actor pinned (its `featured` collection), in its order.
-- Each outbox backfill replaces the actor's set.
CREATE TABLE remote_actor_pins (
  actor_uri TEXT NOT NULL,
  status_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (actor_uri, status_id),
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE,
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);
