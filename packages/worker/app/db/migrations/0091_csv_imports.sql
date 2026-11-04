-- Data import (`/settings/import`): one row per uploaded file, and one row
-- per line of it with the line's outcome. `type` is the `ImportType` kind and
-- `mode` the `ImportMode` kind; `state` is `Queued` until the last page of
-- the job has run, then `Finished`; `Failed` when the queue gave up on the job
-- or it was lost. A line that is not a row of the type is
-- stored `Failed` at upload; the others are `Pending` until the queue job
-- applies them. `row_json` holds the parsed `ImportRow` of a line that
-- passed, `key` what it names (to compare with existing entries in an
-- overwrite). `resolved` is the account (actor URI; for a list row, title and
-- actor URI) the row resolved to, set once it did: an overwrite keeps the
-- entries that match it, whatever the handle text. `reason` is the `RowFailure` kind of a `Failed` line.
CREATE TABLE csv_imports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Queued', 'Finished', 'Failed')),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_csv_imports_account ON csv_imports (account_id, id);

CREATE TABLE csv_import_rows (
  import_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  input TEXT NOT NULL,
  row_json TEXT,
  key TEXT NOT NULL DEFAULT '',
  resolved TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('Pending', 'Applied', 'Failed')),
  reason TEXT,
  PRIMARY KEY (import_id, position),
  FOREIGN KEY (import_id) REFERENCES csv_imports(id) ON DELETE CASCADE
);

CREATE INDEX idx_csv_import_rows_key ON csv_import_rows (import_id, key);

CREATE INDEX idx_csv_import_rows_resolved ON csv_import_rows (import_id, resolved);
