-- void:allow-destructive
-- (Void gate: the DROP TABLE belongs to a SQLite table rebuild; rows are copied first.)
-- Both ends of a quote are a local or a cached remote status, each named in
-- exactly one of two columns, as favourites and bookmarks do (0092). The
-- quoted end keeps 0052's "no foreign key" rule, so a gone original still
-- leaves a row to report as `deleted`.

CREATE TABLE status_quotes_new (
  id TEXT PRIMARY KEY,
  status_id TEXT UNIQUE REFERENCES statuses(id) ON DELETE CASCADE,
  remote_status_id TEXT UNIQUE REFERENCES remote_statuses(id) ON DELETE CASCADE,
  quoted_status_id TEXT,
  quoted_remote_status_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'revoked', 'deleted')),
  -- The remote quoted author's QuoteAuthorization. A local quoted status's
  -- stamp URI is derived from `id`, so it is never stored.
  approval_uri TEXT,
  -- The QuoteRequest id: ours when a local status quotes a remote one, theirs
  -- when a remote status quotes a local one.
  activity_uri TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status_id IS NULL) <> (remote_status_id IS NULL)),
  CHECK ((quoted_status_id IS NULL) <> (quoted_remote_status_id IS NULL)),
  CHECK (approval_uri IS NULL OR quoted_remote_status_id IS NOT NULL)
);

INSERT INTO status_quotes_new (id, status_id, quoted_status_id, state, created_at, updated_at)
  SELECT id, status_id, quoted_status_id, state, created_at, updated_at FROM status_quotes;

DROP TABLE status_quotes;
ALTER TABLE status_quotes_new RENAME TO status_quotes;

CREATE INDEX idx_status_quotes_quoted ON status_quotes (quoted_status_id, state)
  WHERE quoted_status_id IS NOT NULL;
CREATE INDEX idx_status_quotes_quoted_remote ON status_quotes (quoted_remote_status_id, state)
  WHERE quoted_remote_status_id IS NOT NULL;
CREATE INDEX idx_status_quotes_approval ON status_quotes (approval_uri)
  WHERE approval_uri IS NOT NULL;
