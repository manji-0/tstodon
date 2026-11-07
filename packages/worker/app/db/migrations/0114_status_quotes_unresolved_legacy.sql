-- void:allow-destructive
-- (Void gate: the DROP TABLE belongs to a SQLite table rebuild; rows are copied first.)
-- A remote quote may name a quoted note that could not be fetched yet, as
-- Mastodon keeps a quote with no `quoted_status`: its URI is `quoted_uri`, and
-- the quoted end is then in neither status column. Only a remote quoting
-- status names one. `legacy` marks a quote named only by `_misskey_quote`,
-- `quoteUrl` or `quoteUri`, as Mastodon's `quotes.legacy`.

CREATE TABLE status_quotes_new (
  id TEXT PRIMARY KEY,
  status_id TEXT UNIQUE REFERENCES statuses(id) ON DELETE CASCADE,
  remote_status_id TEXT UNIQUE REFERENCES remote_statuses(id) ON DELETE CASCADE,
  quoted_status_id TEXT,
  quoted_remote_status_id TEXT,
  quoted_uri TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'revoked', 'deleted')),
  approval_uri TEXT,
  activity_uri TEXT UNIQUE,
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status_id IS NULL) <> (remote_status_id IS NULL)),
  CHECK (
    (quoted_status_id IS NOT NULL) + (quoted_remote_status_id IS NOT NULL) + (quoted_uri IS NOT NULL) = 1
  ),
  CHECK (quoted_uri IS NULL OR remote_status_id IS NOT NULL),
  CHECK (approval_uri IS NULL OR quoted_remote_status_id IS NOT NULL)
);

INSERT INTO status_quotes_new (id, status_id, remote_status_id, quoted_status_id,
    quoted_remote_status_id, state, approval_uri, activity_uri, created_at, updated_at)
  SELECT id, status_id, remote_status_id, quoted_status_id, quoted_remote_status_id, state,
    approval_uri, activity_uri, created_at, updated_at
  FROM status_quotes;

DROP TABLE status_quotes;
ALTER TABLE status_quotes_new RENAME TO status_quotes;

CREATE INDEX idx_status_quotes_quoted ON status_quotes (quoted_status_id, state)
  WHERE quoted_status_id IS NOT NULL;
CREATE INDEX idx_status_quotes_quoted_remote ON status_quotes (quoted_remote_status_id, state)
  WHERE quoted_remote_status_id IS NOT NULL;
CREATE INDEX idx_status_quotes_approval ON status_quotes (approval_uri)
  WHERE approval_uri IS NOT NULL;
