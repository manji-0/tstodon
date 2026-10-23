-- Quote posts: the quoting status points at the quoted status, and the quoted
-- author's policy (who may quote it) is stored beside it. `quoted_status_id`
-- has no foreign key so a deleted original still leaves a quote row to report
-- as `deleted`.

CREATE TABLE IF NOT EXISTS status_quotes (
    id TEXT PRIMARY KEY,
    status_id TEXT NOT NULL UNIQUE,
    quoted_status_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_status_quotes_quoted
    ON status_quotes (quoted_status_id, state, status_id DESC);

CREATE TABLE IF NOT EXISTS status_quote_policies (
    status_id TEXT PRIMARY KEY,
    policy TEXT NOT NULL,
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);
