-- An `Undo` that found nothing to undo, by its actor and the id of the
-- activity it names. That activity is dropped when it arrives within six
-- hours (Mastodon's `delete_later!` and `delete_arrived_first?`): a sender
-- that delivers an activity and its `Undo` at once can have the `Undo`
-- handled first. The activity vacuum deletes the rows past six hours.
CREATE TABLE undone_before_arrival (
  actor_uri TEXT NOT NULL,
  activity_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_uri, activity_uri)
);

CREATE INDEX idx_undone_before_arrival_created_at ON undone_before_arrival (created_at);
