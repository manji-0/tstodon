-- Status edit history: one snapshot JSON per revision.

CREATE TABLE IF NOT EXISTS status_edits (
    id TEXT PRIMARY KEY,
    status_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_status_edits_status_created
    ON status_edits (status_id, created_at DESC, id DESC);
