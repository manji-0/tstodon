-- A local status whose `Create`, or whose edit's `Update`, could not be built
-- when it was stored (its media or quote did not read back), so that the
-- `FederatePendingStatuses` job sends it later (FED-14). One row per status:
-- an owed `Create` stays a `Create` through later edits. `revision` changes
-- whenever the status changes while the row waits, so a retry that built an
-- older version stores nothing. The row goes with its status.
CREATE TABLE pending_status_federations (
  status_id TEXT PRIMARY KEY REFERENCES statuses(id) ON DELETE CASCADE,
  activity TEXT NOT NULL CHECK (activity IN ('Create', 'Update')),
  revision INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_pending_status_federations_due
  ON pending_status_federations (next_attempt_at);
