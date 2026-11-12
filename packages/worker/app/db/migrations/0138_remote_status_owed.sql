-- The late work a remote `Create` or `Update` still owes a stored note: its
-- mention rows and notifications, quote, link card and stream events run
-- after the batch that writes the row. A marker is written in that batch and
-- deleted when the late steps finish, so a delivery that failed in between
-- leaves one, and the sender's redelivery of the note finishes the work.
-- `kind` is what the write was: `Created` (a note stored by an inbox
-- activity) or `Edited` (an `Update` that changed its content). `token` names
-- the delivery that wrote the marker, which is the only one that deletes it.
-- No payload: the redelivery carries the document.
CREATE TABLE remote_status_owed (
  status_id TEXT NOT NULL REFERENCES remote_statuses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('Created', 'Edited')),
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (status_id, kind)
);

-- The sweep deletes markers past their retention by age.
CREATE INDEX idx_remote_status_owed_created_at ON remote_status_owed (created_at);
