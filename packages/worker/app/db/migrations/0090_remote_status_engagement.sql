-- void:allow-destructive
-- (Void gate: the DROP TABLEs belong to a SQLite table rebuild; rows are copied first.)
-- Local accounts favourite, bookmark, and boost cached remote statuses as well
-- as local ones. Each row names its status in exactly one of `local_status_id`
-- / `remote_status_id`, as `remote_boosts` does, and goes with that status.

CREATE TABLE favourites_new (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  local_status_id TEXT,
  remote_status_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((local_status_id IS NULL) <> (remote_status_id IS NULL)),
  UNIQUE (account_id, local_status_id),
  UNIQUE (account_id, remote_status_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (local_status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (remote_status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

INSERT INTO favourites_new (id, account_id, local_status_id, created_at)
  SELECT
    COALESCE(f.id, CAST(strftime('%s', f.created_at) AS INTEGER) * 1000 * 65536 + f.rowid % 65536),
    f.account_id, f.status_id, f.created_at
  FROM favourites f
  WHERE EXISTS (SELECT 1 FROM statuses s WHERE s.id = f.status_id)
    AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = f.account_id);

DROP TABLE favourites;
ALTER TABLE favourites_new RENAME TO favourites;

CREATE INDEX idx_favourites_status ON favourites (local_status_id, id)
  WHERE local_status_id IS NOT NULL;
CREATE INDEX idx_favourites_remote_status ON favourites (remote_status_id, id)
  WHERE remote_status_id IS NOT NULL;

CREATE TABLE bookmarks_new (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  local_status_id TEXT,
  remote_status_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((local_status_id IS NULL) <> (remote_status_id IS NULL)),
  UNIQUE (account_id, local_status_id),
  UNIQUE (account_id, remote_status_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (local_status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (remote_status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

INSERT INTO bookmarks_new (id, account_id, local_status_id, created_at)
  SELECT
    CAST(strftime('%s', b.created_at) AS INTEGER) * 1000 * 65536 + b.rowid % 65536,
    b.account_id, b.status_id, b.created_at
  FROM bookmarks b
  WHERE EXISTS (SELECT 1 FROM statuses s WHERE s.id = b.status_id)
    AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.account_id);

DROP TABLE bookmarks;
ALTER TABLE bookmarks_new RENAME TO bookmarks;

CREATE INDEX idx_bookmarks_status ON bookmarks (local_status_id)
  WHERE local_status_id IS NOT NULL;
CREATE INDEX idx_bookmarks_remote_status ON bookmarks (remote_status_id)
  WHERE remote_status_id IS NOT NULL;

-- A local boost of a cached remote status names it here instead of in
-- `reblog_of_id`, and goes with it.
ALTER TABLE statuses ADD COLUMN reblog_of_remote_id TEXT
  REFERENCES remote_statuses(id) ON DELETE CASCADE;

CREATE INDEX idx_statuses_reblog_of_remote ON statuses (reblog_of_remote_id, id)
  WHERE reblog_of_remote_id IS NOT NULL;
